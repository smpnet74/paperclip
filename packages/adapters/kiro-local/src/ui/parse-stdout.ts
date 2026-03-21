import type { StdoutLineParser } from "@paperclipai/adapter-utils";
import { stripAnsi } from "../server/parse.js";

/**
 * Parse a stdout line into transcript entries.
 */
export const parseStdoutLine: StdoutLineParser = (line: string, ts: string) => {
  if (!line || line.trim().length === 0) return [];

  // Strip ANSI escape codes before creating transcript entry
  const cleanedLine = stripAnsi(line);

  // Return assistant output
  return [{ kind: "assistant", ts, text: cleanedLine }];
};
