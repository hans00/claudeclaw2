/**
 * Per-turn model routing. Direct port of v1's classifyTask logic, plus
 * per-mode scores in the return value so the caller's hysteresis layer
 * can compute a margin against the CURRENT mode (which may not be the
 * top-scored one).
 *
 * Each mode has a list of keywords + optional phrases. Phrase matches win
 * outright (high confidence). Otherwise keyword score decides; ties prefer
 * the configured `defaultMode`. Question marks add a small bias toward
 * phrase-defining modes (i.e. "planning"-like).
 */
import type { AgenticMode } from "./config";

export interface ModeScore {
  /** Mode name (e.g. "planning", "implementation"). */
  mode: string;
  /** Keyword hit count, plus the question-mark bonus when applicable. */
  score: number;
}

export interface TaskClassification {
  mode: string;
  model: string;
  confidence: number;
  reasoning: string;
  /**
   * Per-mode keyword scores after all bonuses. Sorted descending. Used by
   * the channel's hysteresis check to measure margin against the current
   * mode rather than just the top vs second comparison the router did.
   */
  scores: ModeScore[];
}

export function classifyTask(
  prompt: string,
  modes: AgenticMode[],
  defaultMode: string,
): TaskClassification {
  const normalized = prompt.toLowerCase().trim();

  // Compute keyword scores up front so they're available to both the
  // phrase-match return and the keyword-scoring path.
  const scores = modes.map((mode) => {
    let score = 0;
    for (const keyword of mode.keywords) {
      if (normalized.includes(keyword)) score++;
    }
    return { mode, score };
  });
  const questionMarks = (normalized.match(/\?/g) || []).length;
  if (questionMarks > 0) {
    for (const entry of scores) {
      if (entry.mode.phrases && entry.mode.phrases.length > 0) {
        entry.score += questionMarks * 0.5;
      }
    }
  }
  const scoreSnapshot: ModeScore[] = scores
    .map((s) => ({ mode: s.mode.name, score: s.score }))
    .sort((a, b) => b.score - a.score);

  // Phrase match wins outright (confidence 0.95). Hysteresis layer treats
  // this as user-explicit intent and bypasses sticky-window / margin gates.
  for (const mode of modes) {
    if (!mode.phrases) continue;
    for (const phrase of mode.phrases) {
      if (normalized.includes(phrase)) {
        return {
          mode: mode.name,
          model: mode.model,
          confidence: 0.95,
          reasoning: `phrase "${phrase}" → ${mode.name}`,
          scores: scoreSnapshot,
        };
      }
    }
  }

  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  const second = scores[1];

  if (top && top.score > 0) {
    if (!second || top.score > second.score) {
      const diff = second ? top.score - second.score : top.score;
      const confidence = Math.min(0.9, 0.6 + diff * 0.1);
      return {
        mode: top.mode.name,
        model: top.mode.model,
        confidence,
        reasoning: `${top.mode.name}:${top.score}${second ? ` vs ${second.mode.name}:${second.score}` : ""}`,
        scores: scoreSnapshot,
      };
    }
    const tied = scores.filter((s) => s.score === top.score);
    const tiedFallback = tied.find((s) => s.mode.name === defaultMode) ?? top;
    return {
      mode: tiedFallback.mode.name,
      model: tiedFallback.mode.model,
      confidence: 0.6,
      reasoning: `tie ${tied.map((s) => s.mode.name).join("/")} → ${tiedFallback.mode.name}`,
      scores: scoreSnapshot,
    };
  }

  const fallback = modes.find((m) => m.name === defaultMode) ?? modes[0];
  if (!fallback) {
    return {
      mode: "unknown",
      model: "",
      confidence: 0,
      reasoning: "no modes configured",
      scores: scoreSnapshot,
    };
  }
  return {
    mode: fallback.name,
    model: fallback.model,
    confidence: 0.5,
    reasoning: `ambiguous → ${fallback.name}`,
    scores: scoreSnapshot,
  };
}

export function selectModel(
  prompt: string,
  modes: AgenticMode[],
  defaultMode: string,
): {
  model: string;
  mode: string;
  confidence: number;
  scores: ModeScore[];
  reasoning: string;
} {
  const c = classifyTask(prompt, modes, defaultMode);
  return {
    model: c.model,
    mode: c.mode,
    confidence: c.confidence,
    scores: c.scores,
    reasoning: c.reasoning,
  };
}
