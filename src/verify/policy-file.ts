import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import { MAX_POLICY_BYTES, parsePolicy, PolicyError, type Policy, type PolicyVocabulary } from "../policy";

/** The active policy of `/verify`: replaced only by a file that validates (FR-017, US3-3). */

export type PolicyStatus = { file: string; rules: number | null; loadedAt: string | null; lastError: string | null };

export type PolicyHolder = {
  /** Reads and validates the file; keeps the previous policy when it is invalid. */
  load(): Promise<boolean>;
  /** Reloads on file changes (debounced); returns a stop function. */
  watch(debounceMs?: number): () => void;
  current(): Policy | null;
  status(): PolicyStatus;
};

export function createPolicyHolder(file: string, vocabulary: PolicyVocabulary, log: (line: string) => void = () => {}): PolicyHolder {
  let policy: Policy | null = null;
  let loadedAt: Date | null = null;
  let lastError: string | null = null;

  const holder: PolicyHolder = {
    async load() {
      try {
        const f = Bun.file(file);
        if (f.size > MAX_POLICY_BYTES) throw new PolicyError([`policy is larger than ${MAX_POLICY_BYTES} bytes`]);
        const next = parsePolicy(await f.text(), vocabulary);
        policy = next;
        loadedAt = new Date();
        lastError = null;
        log(`policy ${file}: loaded ${next.rules.length} rule(s)`);
        return true;
      } catch (error) {
        lastError = error instanceof PolicyError ? error.problems.join("; ") : `cannot read ${file}: ${(error as Error).message}`;
        log(`policy ${file}: rejected, keeping the previous policy (${lastError})`);
        return false;
      }
    },
    watch(debounceMs = 500) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      // The directory is watched: editors and ConfigMaps replace the file instead of writing it.
      const name = basename(file);
      const watcher = watch(dirname(file), (_event, changed) => {
        if (changed !== null && changed !== name && !changed.startsWith("..")) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void holder.load(), debounceMs);
      });
      return () => {
        if (timer) clearTimeout(timer);
        watcher.close();
      };
    },
    current: () => policy,
    status: () => ({ file, rules: policy?.rules.length ?? null, loadedAt: loadedAt?.toISOString() ?? null, lastError }),
  };
  return holder;
}
