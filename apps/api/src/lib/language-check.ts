import { franc } from "franc-min";

/**
 * Cheap, no-LLM language detection backed by `franc-min`'s trigram model
 * (~80 languages, returns ISO 639-3 codes; "und" = undetermined).
 *
 * franc requires ~10 chars of text to give a stable answer; below that we
 * return null and let the caller skip the check.
 */

export interface LanguageCheckResult {
  /** ISO 639-3 detected language, or null if too short / undetermined. */
  detected: string | null;
  /** True when detected !== "eng" — useful as a fast "is it English?" gate. */
  isLikelyNonEnglish: boolean;
}

export function detectLanguage(text: string): LanguageCheckResult {
  const trimmed = text.trim();
  if (trimmed.length < 30) return { detected: null, isLikelyNonEnglish: false };
  const code = franc(trimmed, { minLength: 10 });
  if (code === "und") return { detected: null, isLikelyNonEnglish: false };
  return { detected: code, isLikelyNonEnglish: code !== "eng" };
}

/**
 * Decide whether a candidate translation is genuinely English. Returns false
 * when the detector says the text is in another language with reasonable
 * confidence. Short texts (< 30 chars) get the benefit of the doubt — too
 * little signal for franc to be reliable.
 */
export function isProbablyEnglish(text: string): boolean {
  const result = detectLanguage(text);
  if (result.detected === null) return true;
  return result.detected === "eng";
}
