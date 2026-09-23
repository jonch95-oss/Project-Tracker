#!/usr/bin/env node
/**
 * Backup storage on Vercel Blob (private). Used by the nightly workflow and
 * the restore drill. Needs BLOB_READ_WRITE_TOKEN.
 *
 *   node scripts/ops/blob-backup.mjs upload <file>     → uploads to backups/, prunes to 30, prints JSON
 *   node scripts/ops/blob-backup.mjs latest <outfile>  → downloads the newest dump
 *   node scripts/ops/blob-backup.mjs list
 */
import { createWriteStream, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { del, get, list, put } from "@vercel/blob";

const KEEP = 30;
const PREFIX = "backups/";
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error("BLOB_READ_WRITE_TOKEN is not set");
  process.exit(1);
}

async function all() {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix: PREFIX, cursor, limit: 1000, token });
    out.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  // Names embed a UTC timestamp, so lexical order is chronological.
  return out.sort((a, b) => a.pathname.localeCompare(b.pathname));
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "upload") {
  const size = statSync(arg).size;
  const pathname = `${PREFIX}${basename(arg)}`;
  await put(pathname, readFileSync(arg), { access: "private", token, contentType: "application/octet-stream", multipart: size > 50 * 1024 * 1024 });
  const blobs = await all();
  const stale = blobs.slice(0, Math.max(0, blobs.length - KEEP)).map((b) => b.url);
  if (stale.length) await del(stale, { token });
  console.log(JSON.stringify({ objectKey: pathname, sizeBytes: size, pruned: stale.length, kept: Math.min(blobs.length, KEEP) }));
} else if (cmd === "latest") {
  const blobs = await all();
  const newest = blobs.at(-1);
  if (!newest) {
    console.error("No backups found");
    process.exit(1);
  }
  const r = await get(newest.url, { access: "private", token });
  if (!r || r.statusCode !== 200) throw new Error(`Could not download ${newest.pathname}`);
  await pipeline(Readable.fromWeb(r.stream), createWriteStream(arg));
  console.log(JSON.stringify({ objectKey: newest.pathname, sizeBytes: newest.size, uploadedAt: newest.uploadedAt }));
} else if (cmd === "list") {
  for (const b of await all()) console.log(`${b.uploadedAt.toISOString?.() ?? b.uploadedAt}  ${String(b.size).padStart(12)}  ${b.pathname}`);
} else {
  console.error("usage: blob-backup.mjs upload <file> | latest <outfile> | list");
  process.exit(1);
}
