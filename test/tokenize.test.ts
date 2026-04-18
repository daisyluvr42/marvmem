import test from "node:test";
import assert from "node:assert/strict";
import { tokenize, uniqueTokens, tokenOverlapScore } from "../src/core/tokenize.js";

test("tokenizes Latin text by spaces, filtering short tokens", () => {
  const tokens = tokenize("Hello world I am here");
  assert.deepEqual(tokens, ["hello", "world", "am", "here"]);
});

test("tokenizes Chinese text by individual characters", () => {
  const tokens = tokenize("用户偏好简洁的中文回复");
  assert.deepEqual(tokens, ["用", "户", "偏", "好", "简", "洁", "的", "中", "文", "回", "复"]);
});

test("tokenizes mixed CJK and Latin text", () => {
  const tokens = tokenize("Alice偏好Chinese回复");
  // "alice偏好chinese回复" → split produces one segment, CJK detected
  assert.ok(tokens.includes("偏"));
  assert.ok(tokens.includes("好"));
  assert.ok(tokens.includes("回"));
  assert.ok(tokens.includes("复"));
});

test("uniqueTokens deduplicates", () => {
  const tokens = uniqueTokens("hello hello world");
  assert.deepEqual(tokens, ["hello", "world"]);
});

test("tokenOverlapScore handles CJK correctly", () => {
  const query = uniqueTokens("中文回复");
  const candidate = uniqueTokens("用户偏好简洁的中文回复");
  const score = tokenOverlapScore(query, candidate);
  // All query tokens should be found in candidate
  assert.equal(score, 1);
});

test("tokenOverlapScore returns 0 for no overlap", () => {
  const query = uniqueTokens("hello world");
  const candidate = uniqueTokens("foo bar");
  const score = tokenOverlapScore(query, candidate);
  assert.equal(score, 0);
});
