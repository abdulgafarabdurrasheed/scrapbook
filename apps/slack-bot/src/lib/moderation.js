import { createHash } from "node:crypto";
import prisma from "./prisma.js";
import {
  findModerationMatches,
  moderationRulesConfigured,
} from "./automod-rules.js";

const SCAN_INTERVAL_MS = 30 * 60 * 1000;
const SCAN_STATE_ID = "scrapbook-posts";
const SCAN_PAGE_SIZE = 200;

const updateLocks = new Map();

const hashText = (text) =>
  createHash("sha256").update(text || "", "utf8").digest("hex");

const withUpdateLock = async (updateId, operation) => {
  const previous = updateLocks.get(updateId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  updateLocks.set(updateId, current);
  await previous;

  try {
    return await operation();
  } finally {
    release();
    if (updateLocks.get(updateId) === current) updateLocks.delete(updateId);
  }
};

export const processUpdateForModeration = (update) =>
  withUpdateLock(update.id, async () => {
    const contentHash = hashText(update.text);
    const matches = await findModerationMatches(update.text || "");
    const flaggedTerms = [...new Set(matches.map(({ word }) => word))];
    let review = await prisma.moderationReview.findUnique({
      where: { updateId: update.id },
    });

    if (!review) {
      if (!flaggedTerms.length) return null;

      await prisma.moderationReview.createMany({
        data: [
          {
            updateId: update.id,
            contentHash,
            flaggedTerms,
          },
        ],
        skipDuplicates: true,
      });
      review = await prisma.moderationReview.findUnique({
        where: { updateId: update.id },
      });
      if (!review) throw new Error(`Could not save moderation review for ${update.id}`);
      return review;
    }

    if (review.contentHash === contentHash) return review;

    if (!flaggedTerms.length) {
      if (review.status === "pending") {
        return prisma.moderationReview.update({
          where: { id: review.id },
          data: {
            contentHash,
            flaggedTerms: [],
            status: "superseded",
            reviewedAt: new Date(),
          },
        });
      }
      return review;
    }

    return prisma.moderationReview.update({
      where: { id: review.id },
      data: {
        contentHash,
        flaggedTerms,
        status: "pending",
        reportChannel: null,
        reportMessageTs: null,
        rejectionReason: null,
        reviewedBy: null,
        reviewedAt: null,
      },
    });
  });

const scanPage = async (windowStart, scanThrough, cursor) => {
  const dateFilter = {
    postTime: { gte: windowStart, lte: scanThrough },
  };
  const cursorFilter = cursor
    ? {
        OR: [
          { postTime: { gt: cursor.postTime } },
          { postTime: cursor.postTime, id: { gt: cursor.id } },
        ],
      }
    : null;

  return prisma.updates.findMany({
    where: cursorFilter ? { AND: [dateFilter, cursorFilter] } : dateFilter,
    orderBy: [{ postTime: "asc" }, { id: "asc" }],
    take: SCAN_PAGE_SIZE,
    select: {
      id: true,
      postTime: true,
      text: true,
      accountsID: true,
      accountsSlackID: true,
      channel: true,
      messageTimestamp: true,
      attachments: true,
    },
  });
};

export const scanRecentScrapbookPosts = async () => {
  if (!moderationRulesConfigured) {
    console.warn("Scrapbook AutoMod scan skipped: no flag rules are configured.");
    return;
  }

  const now = Date.now();
  const scanThrough = new Date(now - 5_000);
  const state = await prisma.moderationScanState.upsert({
    where: { id: SCAN_STATE_ID },
    create: {
      id: SCAN_STATE_ID,
      lastScannedAt: new Date(now - SCAN_INTERVAL_MS),
    },
    update: {},
  });
  if (!state?.lastScannedAt) throw new Error("Could not load moderation scan state");

  // Re-scan one interval of overlap in case an event arrived late. Review
  // records are keyed by update ID and content hash, so unchanged posts do not
  // create duplicate alerts.
  const windowStart = new Date(state.lastScannedAt.getTime() - SCAN_INTERVAL_MS);
  let cursor = null;
  let scanned = 0;

  while (true) {
    const updates = await scanPage(windowStart, scanThrough, cursor);
    if (!Array.isArray(updates)) throw new Error("Could not read Scrapbook posts for moderation");
    if (!updates.length) break;

    for (const update of updates) {
      await processUpdateForModeration(update);
      cursor = { postTime: update.postTime, id: update.id };
      scanned += 1;
    }

    if (updates.length < SCAN_PAGE_SIZE) break;
  }

  await prisma.moderationScanState.update({
    where: { id: SCAN_STATE_ID },
    data: { lastScannedAt: scanThrough, lastScannedId: "" },
  });
  console.log(`Scrapbook AutoMod scanned ${scanned} post(s).`);
};

let scanTimer;
let scanInProgress = false;

export const startModerationScanner = () => {
  if (scanTimer) return;

  const runScan = async () => {
    if (scanInProgress) return;
    scanInProgress = true;
    try {
      await scanRecentScrapbookPosts();
    } catch (error) {
      console.error("Scrapbook AutoMod scan failed:", error);
    } finally {
      scanInProgress = false;
    }
  };

  void runScan();
  scanTimer = setInterval(runScan, SCAN_INTERVAL_MS);
  scanTimer.unref?.();
};
