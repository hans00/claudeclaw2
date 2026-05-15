/**
 * Per-turn model routing. Direct port of v1's classifyTask logic.
 *
 * Each mode has a list of keywords + optional phrases. Phrase matches win
 * outright (high confidence). Otherwise keyword score decides; ties prefer
 * the configured `defaultMode`. Question marks add a small bias toward
 * phrase-defining modes (i.e. "planning"-like).
 */
import type { AgenticMode } from "./config";

export interface TaskClassification {
  mode: string;
  model: string;
  confidence: number;
  reasoning: string;
}

export function classifyTask(
  prompt: string,
  modes: AgenticMode[],
  defaultMode: string,
): TaskClassification {
  const normalized = prompt.toLowerCase().trim();

  // Phrases (high priority)
  for (const mode of modes) {
    if (!mode.phrases) continue;
    for (const phrase of mode.phrases) {
      if (normalized.includes(phrase)) {
        return {
          mode: mode.name,
          model: mode.model,
          confidence: 0.95,
          reasoning: `phrase "${phrase}" → ${mode.name}`,
        };
      }
    }
  }

  // Keyword scoring
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
      };
    }
    const tied = scores.filter((s) => s.score === top.score);
    const tiedFallback = tied.find((s) => s.mode.name === defaultMode) ?? top;
    return {
      mode: tiedFallback.mode.name,
      model: tiedFallback.mode.model,
      confidence: 0.6,
      reasoning: `tie ${tied.map((s) => s.mode.name).join("/")} → ${tiedFallback.mode.name}`,
    };
  }

  const fallback = modes.find((m) => m.name === defaultMode) ?? modes[0];
  if (!fallback) {
    return { mode: "unknown", model: "", confidence: 0, reasoning: "no modes configured" };
  }
  return {
    mode: fallback.name,
    model: fallback.model,
    confidence: 0.5,
    reasoning: `ambiguous → ${fallback.name}`,
  };
}

export function selectModel(
  prompt: string,
  modes: AgenticMode[],
  defaultMode: string,
): { model: string; mode: string; reasoning: string } {
  const c = classifyTask(prompt, modes, defaultMode);
  return { model: c.model, mode: c.mode, reasoning: c.reasoning };
}
