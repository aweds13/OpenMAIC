/**
 * Static system-prompt guidance for materials and the knowledge base (RFC #1716 §4).
 *
 * Present on every run, attached materials or not: a conversation with nothing
 * attached can still use the user's knowledge base. The text does not name the
 * set — no names, ids, kinds, counts, or extraction status — and does not add a
 * sentence that depends on it. Those bytes are the head of the provider prompt,
 * so a change would invalidate the prefix cache for the whole conversation.
 * `list_materials` lists what is attached. A follow-up's attachment note and a
 * `fetch_url` result name what was just added.
 *
 * `materials` is accepted so the runner can keep passing the resolved set. The
 * block must not read it.
 */
import { MATERIAL_USER_WORDING } from './material-model-copy';
import type { ResolvedMaterial } from './material-resolver';

export function materialsPromptBlock(materials: readonly ResolvedMaterial[]): string {
  void materials;
  return [
    '## Materials and the knowledge base',
    '',
    "The user's knowledge base holds their uploaded materials, in folders. `list_materials` lists it, newest first: each row says whether it is `attached` to this conversation and where it sits in the knowledge base, and the call also returns every folder with how many materials it holds. Filter by `folderId` (`top-level` means not in a folder), `query`, `kind` or `source`. Listings are paged: when one returns `nextBefore`, call again with `before` set to that value and the same filters; a cursor from different filters comes back as an empty page with `staleCursor` set, so just list again without `before`.",
    "Reading a material: `read_material` with its id. A readable source comes back in one piece up to about 30000 characters; longer text is paged, so continue with the `nextOffset` and the `revision` the previous page returned, and if the text changed start again at offset 0. A source whose text is not parsed yet answers `extraction_required` — parsing is started by the upload, so read it again later rather than trying to trigger it. A `textChars` in a listing is approximate; `read_material` reports the exact length. The notes you keep in the knowledge base are read the same way, by the id `topic:<slug>` (`topic:INDEX` is the index itself).",
    '`search_materials` finds case-insensitive literal text across readable materials, across the whole knowledge base. Each hit carries a short snippet and an offset; a short material also comes back with its full text, so read longer ones with `read_material` before quoting them.',
    'Images and keyframes extracted from a source are materials of their own (their listing names the source in `derivedFrom`, with any page or time), and extracted text names them as `material:<id>`. To show image, video or audio material on a page, call `use_material_media` with its id and the stage, and put the returned `src` on the media element.',
    'A `web` material is already fetched and extracted, so read it directly.',
    MATERIAL_USER_WORDING,
    'To organize the knowledge base: `organize_materials`, with `action` naming what to do — create a folder, rename a folder, move materials into a folder or back to the top level (a source moves with its images and keyframes, and `folderId: "top-level"` moves it out of its folder), or rename a material. `add_materials` with `target: "note"` writes the notes you keep: `mode: "append"` adds a block to a topic note, `mode: "replace"` rewrites it and needs the revision the last read returned. Deleting a material or a folder is left to the user, on the knowledge base page: you cannot delete.',
    'An attached .pptx can be imported INTO a stage as appended pages with `import_pptx` (layout-preserving: original slides become pages; the stage keeps its own title). Use that instead of an AI rewrite when the user wants the PowerPoint’s own pages.',
  ].join('\n');
}
