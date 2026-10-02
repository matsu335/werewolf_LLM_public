import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { LANGUAGES } from "../domain/constants.js";
import { outputRules } from "./messages.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../config");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// private_thought を出力スキーマに持つ呼び出し。出力規則でこのフィールドに触れるのはこれらだけ。
const CALLS_WITH_THOUGHT = new Set(["co", "discussion"]);

export const CALL_TYPES = Object.freeze(["co", "discussion", "vote", "attack", "divination", "guard", "wolf_meeting", "strategy_memory"]);

export class PromptStore {
  constructor(root = ROOT) { this.root = root; }

  load(relativePath) {
    const fullPath = path.resolve(this.root, relativePath);
    if (!fullPath.startsWith(path.resolve(this.root))) throw new Error("Invalid prompt path");
    const content = readFileSync(fullPath, "utf8");
    return { relativePath, content, sha256: sha256(content) };
  }

  bundle(callType, role, language = "ja") {
    if (!LANGUAGES.includes(language)) throw new Error(`Unknown language: ${language}`);
    // 夜行動は役職ごとに意味も帰結も違う。同じ指示文を共有させると、狩人が処刑投票を
    // 「護衛先の指名」と読むような取り違えが起きるため、呼び出し種別ごとに別の文書を渡す。
    if (!CALL_TYPES.includes(callType)) throw new Error(`Unknown call type: ${callType}`);
    const rulebook = this.load(`${language}/rules/rulebook.md`);
    const roleDoc = this.load(`${language}/roles/${role}.md`);
    const instruction = this.load(`${language}/prompts/${callType}.md`);
    const rules = outputRules(language, { hasThought: CALLS_WITH_THOUGHT.has(callType) });
    return {
      system: `${rules}\n\n${instruction.content}\n\n${rulebook.content}\n\n${roleDoc.content}`,
      files: [instruction, rulebook, roleDoc].map(({ relativePath, sha256: hash }) => ({ path: relativePath, sha256: hash })),
    };
  }
}
