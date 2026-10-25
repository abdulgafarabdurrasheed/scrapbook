import { createHash } from "node:crypto";
import prisma from "./prisma.js";
import {
  findModerationMatches,
  moderationRulesConfigured,
} from "./automod-rules.js";

const SCAN_INTERVAL_MS = 30 * 60 * 1000;
const SCAN_STATE_ID = "scrapbook-posts";
const SCAN_PAGE_SIZE = 200;
const MAX_POST_TEXT_LENGTH = 2_800;

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

const parseModeratorIds = () =>
  (process.env.SCRAPBOOK_MODERATOR_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

const fetchUpdateWithAuthor = (updateId) =>
  prisma.updates.findUnique({
    where: { id: updateId },
    select: {
      id: true,
      text: true,
      postTime: true,
      accountsID: true,
      accountsSlackID: true,
      messageTimestamp: true,
      channel: true,
      Accounts: { select: { username: true, slackID: true } },
      SlackAccounts: { select: { username: true, slackID: true } },
    },
  });

const buildModerationBlocks = (review, update) => {
  const author =
    update.Accounts?.username || update.SlackAccounts?.username || "Unknown";
  const postText = (update.text || "").slice(0, MAX_POST_TEXT_LENGTH);
  const truncated = (update.text || "").length > MAX_POST_TEXT_LENGTH;
  const authorLine = update.accountsSlackID
    ? `Author: ${author} (Slack ID ${update.accountsSlackID})`
    : `Author: ${author}`;
  const actions = [
    {
      type: "button",
      action_id: "scrapbook_moderation_accept",
      text: { type: "plain_text", text: "Not harmful, accept" },
      style: "primary",
      value: JSON.stringify({ id: review.id, hash: review.contentHash }),
    },
    {
      type: "button",
      action_id: "scrapbook_moderation_reject",
      text: { type: "plain_text", text: "Reject" },
      style: "danger",
      value: JSON.stringify({ id: review.id, hash: review.contentHash }),
    },
  ];

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "Potentially Harmful content" },
    },
    {
      type: "section",
      text: {
        type: "plain_text",
        text: postText ? `${postText}${truncated ? "…" : ""}` : "(This post has no text.)",
      },
    },
    {
      type: "context",
      elements: [
        { type: "plain_text", text: authorLine },
        {
          type: "plain_text",
          text: `Matched existing rule(s): ${review.flaggedTerms.join(", ")}`,
        },
      ],
    },
  ];

  if (author !== "Unknown") {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View Scrapbook" },
          url: `https://scrapbook.hackclub.com/${encodeURIComponent(author)}`,
          action_id: "scrapbook_moderation_view_post",
        },
      ],
    });
  }

  blocks.push({ type: "actions", elements: actions });
  return blocks;
};

const closeSupersededAlert = async (client, review) => {
  if (!review.reportChannel || !review.reportMessageTs) return;
  await client.chat.update({
    channel: review.reportChannel,
    ts: review.reportMessageTs,
    text: "This Scrapbook post was edited and no longer matches its previous moderation rule.",
    blocks: [
      {
        type: "section",
        text: {
          type: "plain_text",
          text: "This post was edited and no longer matches the previous rule. The review was closed.",
        },
      },
    ],
  });
};

export const postModerationAlert = async (client, review) => {
  if (!review || review.status !== "pending") return;

  if (review.reportChannel && review.reportMessageTs) return;
  const channel = process.env.SCRAPBOOK_MODERATION_CHANNEL_ID;
  const moderatorIds = parseModeratorIds();
  if (!channel || !moderatorIds.length) {
    console.warn(
      "Scrapbook AutoMod found a match but skipped its alert: set the moderation channel and moderator IDs.",
    );
    return;
  }

  const update = await fetchUpdateWithAuthor(review.updateId);
  if (!update) return;
  const mentions = moderatorIds.map((id) => `<@${id}>`).join(" ");
  const result = await client.chat.postMessage({
    channel,
    text: `Potentially Harmful content needs review. ${mentions}`,
    blocks: buildModerationBlocks(review, update),
    unfurl_links: false,
    unfurl_media: false,
  });
  if (!result?.ok || !result.ts) {
    throw new Error(`Slack did not confirm the moderation alert: ${result?.error || "unknown error"}`);
  }

  const saved = await prisma.moderationReview.updateMany({
    where: { id: review.id, contentHash: review.contentHash, status: "pending" },
    data: { reportChannel: channel, reportMessageTs: result.ts },
  });
  if (!saved?.count) {
    await client.chat.update({
      channel,
      ts: result.ts,
      text: "This moderation candidate changed before it could be reviewed.",
      blocks: [],
    });
  }
};

const reviewAndAlert = async (client, update) => {
  const previousReview = await prisma.moderationReview.findUnique({
    where: { updateId: update.id },
  });
  const review = await processUpdateForModeration(update);
  if (!review) return;
  if (review.status === "superseded") {
    await closeSupersededAlert(client, review);
    return;
  }
  if (
    previousReview?.status === "pending" &&
    previousReview.contentHash !== review.contentHash &&
    previousReview.reportChannel &&
    previousReview.reportMessageTs
  ) {
    await client.chat.update({
      channel: previousReview.reportChannel,
      ts: previousReview.reportMessageTs,
      text: "This post changed after the alert. Review the updated alert below.",
      blocks: [
        {
          type: "section",
          text: {
            type: "plain_text",
            text: "This post changed after the alert. The previous review card is closed; review the updated card below.",
          },
        },
      ],
    });
  }
  await postModerationAlert(client, review);
};

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

export const scanRecentScrapbookPosts = async (client) => {
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
      await reviewAndAlert(client, update);
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

export const startModerationScanner = (client) => {
  if (scanTimer) return;

  const runScan = async () => {
    if (scanInProgress) return;
    scanInProgress = true;
    try {
      await scanRecentScrapbookPosts(client);
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
