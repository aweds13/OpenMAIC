/**
 * The part of the agent's surface that only this fork has.
 *
 * `runner.ts` is the file upstream rewrites most aggressively — in v1.5.0 the
 * whole tool-assembly block moved inside a new `execution` closure, and every
 * line we had added there had to be transplanted by hand. Most of what we had
 * added was two long literals: the registration order of our tool groups, and
 * the nineteen-entry prompt-block object. Neither reads anything the runner
 * cannot pass in, so both live here now and the runner keeps a two-line call.
 *
 * Why the split is worth the file:
 *
 * 1. **The prompt blocks stop being a literal inside a closure.** Nineteen
 *    entries, half of them conditional, is exactly the shape that merges
 *    badly: a conflict inside an object literal has to be re-read in full
 *    because the surrounding lines decide what the entries mean.
 *
 * 2. **The capability-gated six stay out.** `search`, `fetch`, `image`,
 *    `video`, `tts`, `voiceRegistration` and `unavailableCapabilities` are
 *    filled by `assembleCapabilityRuntime` from the resolved slots, so they are
 *    deliberately absent here: one block named in two places is a block that
 *    can disagree with itself.
 *
 * Ordering: `buildForkPromptBlocks` returns a `CoursePromptBlocks`, whose key
 * order is not the rendering order — `PROMPT_BLOCK_ORDER` in `course-tools.ts`
 * decides that, and it has a compile-time completeness check over the interface.
 * Adding a block here without adding it there is a type error, not a silent
 * drop.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';

import type { LoadedSkill } from './skills';

import { assessmentModePromptBlock } from './assessment-mode';
import { browsePromptBlock } from './browse-url';
import { courseDesignPromptBlock } from './course-design';
import { courseLibraryPromptBlock } from './course-search';
import type { CoursePromptBlocks } from './course-tools';
import { CURRICULUM_TOOLS_PROMPT } from './curriculum-tools';
import { learnerProfilePromptBlock } from './learner-profile';
import { learnerStatePromptBlock } from './learner-state';
import { materialsIndexPromptBlock } from './materials-library';
import { materialsPromptBlock } from './material-prompt';
import type { ResolvedMaterial } from './material-resolver';
import { mcpPromptBlock } from './mcp-tools';
import { planFreezePromptBlock } from './plan-freeze-tools';
import { practicePromptBlock } from './practice-tools';
import { courseReviewPromptBlock } from './review-tools';
import { ROSTER_TOOLS_PROMPT } from './roster-tools';
import { scratchPromptBlock } from './scratch-tools';
import { availableSkillsPromptBlock, skillChoicePromptBlock } from './skills';
import { studyModePromptBlock } from './study-mode';
import { courseAuditPromptBlock } from './audit-tools';
import { voiceCloneToolsPrompt } from './voice-clone-tools';

/**
 * The tool groups this fork adds on top of upstream's, already built.
 *
 * Passed in rather than built here because each group closes over a different
 * slice of run state (`ownerScopedStore`, `stageAccess`, `abort.signal`,
 * `activeSkill`, …). Building them in the runner keeps that wiring where the
 * rest of the run's wiring is; only the *order* — which is the part that merges
 * badly — lives here.
 */
export interface ForkToolGroups {
  audit: readonly AgentTool[];
  review: readonly AgentTool[];
  scratch: readonly AgentTool[];
  practice: readonly AgentTool[];
  planFreeze: readonly AgentTool[];
}

/**
 * The fork's own tools, in the order they are registered.
 *
 * Registration order is not cosmetic: `assembleRunnerTools` preserves it, and
 * the model sees tools in the order they are listed, so a reordering is a
 * behaviour change no test would catch. Upstream's groups are interleaved from
 * the runner side; this array covers only ours so a merge cannot silently drop
 * one.
 */
export function buildForkCandidateTools(groups: ForkToolGroups): readonly AgentTool[] {
  return [
    ...groups.audit,
    ...groups.review,
    ...groups.scratch,
    ...groups.practice,
    ...groups.planFreeze,
  ];
}

/** Everything the always-on blocks read from the run. */
export interface ForkPromptDeps {
  materials: readonly ResolvedMaterial[];
  /** The library index block, or null when the deployment has no library. */
  materialsIndex: string | null;
  /** Local course-library channel resolved, or null when unconfigured. */
  hasCourseLibrary: boolean;
  /** Local browser channel resolved, or null when unconfigured. */
  hasBrowse: boolean;
  /** Only used for cross-references ("you also have web search"). */
  hasWebSearch: boolean;
  mcpNames: readonly string[];
  learnerProfile: string | null;
  learnerState: string | null;
  installedSkills: readonly LoadedSkill[];
  /** Skills as of now — a Skill created earlier in this run appears here. */
  currentSkills: () => readonly LoadedSkill[];
  planGateEnabled: boolean;
  /** True when a backend can actually register voices (not just synthesize). */
  voiceRegistrationEnabled: boolean;
}

/**
 * The fork's always-on prompt blocks.
 *
 * Capability-dependent blocks are absent on purpose (see the file header).
 * `learnerState` must stay LAST in `PROMPT_BLOCK_ORDER` — it is the only block
 * that changes when the learner answers one question, and everything after it
 * would lose its prefix cache.
 */
export function buildForkPromptBlocks(deps: ForkPromptDeps): CoursePromptBlocks {
  return {
    availableSkills: availableSkillsPromptBlock(deps.currentSkills()),
    // "What exists" is `availableSkills`; this one is "how to choose among
    // them", so the agent recommends a few instead of waiting to be asked.
    skillChoice: deps.installedSkills.length
      ? skillChoicePromptBlock(deps.installedSkills)
      : undefined,
    // "Listen or self-study" — the workbench has no such switch, so ask.
    studyMode: studyModePromptBlock(),
    // Orthogonal to studyMode: input mode vs assessment mode.
    assessmentMode: assessmentModePromptBlock(),
    courseDesign: courseDesignPromptBlock({
      hasMaterials: Boolean(deps.materialsIndex),
      hasCourseLibrary: deps.hasCourseLibrary,
    }),
    // Only when the gate is open: never name a capability that is not there.
    planFreeze: deps.planGateEnabled ? planFreezePromptBlock() : undefined,
    courseAudit: courseAuditPromptBlock(),
    review: courseReviewPromptBlock(),
    scratch: scratchPromptBlock(Boolean(deps.materialsIndex)),
    practice: practicePromptBlock(),
    curriculum: CURRICULUM_TOOLS_PROMPT,
    // Block and registration are the same source: no channel, no block.
    courseLibrary: deps.hasCourseLibrary
      ? courseLibraryPromptBlock({ hasWebSearch: deps.hasWebSearch })
      : undefined,
    browse: deps.hasBrowse ? browsePromptBlock({ hasWebSearch: deps.hasWebSearch }) : undefined,
    mcp: deps.mcpNames.length ? mcpPromptBlock(deps.mcpNames) : undefined,
    materialsLibrary: deps.materialsIndex ? materialsIndexPromptBlock() : undefined,
    learnerProfile: deps.learnerProfile
      ? learnerProfilePromptBlock(deps.learnerProfile)
      : undefined,
    // Always: a conversation with nothing attached can still use the library.
    materials: materialsPromptBlock(deps.materials),
    roster: ROSTER_TOOLS_PROMPT,
    // Deliberately NOT `true` when registration works: that block is filled by
    // the assembler from the slot, and saying it twice says it twice.
    voice: voiceCloneToolsPrompt(deps.voiceRegistrationEnabled ? undefined : false),
    learnerState: deps.learnerState ? learnerStatePromptBlock(deps.learnerState) : undefined,
  };
}
