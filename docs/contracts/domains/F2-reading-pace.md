# F2 阅读节奏与翻页 —— 契约

## 这条契约管什么

管「下一页由谁推进、读者能怎么翻」这条边界的对齐：读者不动作时页面会不会自己跑，读者动作时到底翻了几页。

判定只看**阅读页**（`actions` 长度为 0、只供阅读的页）在两个时刻的表现 —— 静止任意长时间、收到一次物理输入。不管页面里讲什么（F1）、不管自检页怎么判分（F3）。

## 逐条验收

### SR-F2.1 阅读页不得有自动前进；下一页只由读者动作触发

- **输入**：一个 `actions: []` 的场景，经 `PlaybackEngine` 起播（`engine.start()`）。生产侧 `PlaybackChromeRoot` 只传 `[currentScene]` 一个场景，`resolvePlaybackCursor` 会为它合成 `EMPTY_SCENE_DWELL`。
- **期望**：`engine.start()` 后 `advanceTimersByTimeAsync(0)` 即 `engine.getMode() === 'paused'`、`onSpeechStart` 未调用；再推进 `60_000ms`，`onComplete` 仍未调用、`getMode()` 仍 `'paused'`。机制在 `lib/playback/engine.ts:664`：`if (action.id === EMPTY_SCENE_DWELL.id) { this.parkedOnReadOnlyScene = true; this.setMode('paused'); return; }` —— 停在页上等读者，不排任何计时器。
- **失败长什么样**：2 秒后 `onComplete` 被调用、`setPlaybackCompleted(true)`，配上自动播放就把整门课按 2 秒/页推走。旧行为就是这条（测试注释原文：「The old behaviour: 2s later the dwell expired and the page was reported complete — which, with 自动播放 on, advanced the whole course at 2s/page.」）。
- **判据落点**：`tests/playback/reading-page-park.test.ts`，`describe('a scene with no actions is a reading page, not a 2-second beat')` 下的 `parks on it instead of completing after the 2s reading floor`（`:78`）、`leaves a scene that HAS narration on the normal timed path`（`:120`）、`keeps a blank speech clip the user actually has on the timed path`（`:143`）。命令：`npx vitest run tests/playback/reading-page-park.test.ts`。
- **两边各自要满足**：
  - 引擎侧（`lib/playback/engine.ts:664`、`:293-294`）：阅读页 park 之后，收到「播放」必须解释成「这页看完了，往下走」（`parkedOnReadOnlyScene` 复位并前进），**不得**重新起一次 2 秒计时。
  - 自动播放侧（`components/edit/PlaybackChromeRoot.tsx:929-955`）：`autoPlayLecture` 的跳跃挂在 `onComplete` 上 —— 阅读页既然永不 complete，自动播放就推不动它。这是**间接**成立，不是那条路径自己判的；改 `onComplete` 的触发条件时不许把 park 绕过去。

### SR-F2.2 阅读页的停留时长不得被任何最小时长常量强制

- **输入**：`estimateSpeechDurationMs(text, opts?)`（`lib/choreography/timing.ts`），`MIN_READING_MS = 2000`（`:89`，**非 export**）、`CJK_MS_PER_CHAR = 150`（`:92`）、`NON_CJK_MS_PER_WORD = 240`（`:95`）。
- **期望**：这个函数只对**有旁白的页**生效 —— `estimateSpeechDurationMs('') = max(2000, 0 × 240) = 2000ms` 那条兜底，**不得**作用到阅读页上。阅读页的停留时长由读者决定，没有上限也没有下限。
- **失败长什么样**：阅读页仍走 2 秒计时器（症状与 SR-F2.1 同一个，但成因不同：那条是「不该排计时器」，这条是「排了计时器还用 2000ms 兜底」）；或有人在阅读页上套一层「最短停留 X 秒才能翻」的防误触 —— 防重复触发只能用在去抖上（SR-F2.5），不能变成阅读时长下限。
- **判据落点**：常量本身有判据 —— `tests/lib/choreography/timing.test.ts`，`describe('estimateSpeechDurationMs — deterministic no-audio dwell')` 下的 `CJK text: ~150ms/char, floored at 2000ms`、`non-CJK text: ~240ms/word (≈250 WPM), floored at 2000ms`、`empty text falls to the 2000ms floor`；「这个常量不作用于阅读页」由 `tests/playback/reading-page-park.test.ts` 的 `parks on it instead of completing after the 2s reading floor` 覆盖。命令：`npx vitest run tests/lib/choreography/timing.test.ts tests/playback/reading-page-park.test.ts`。
- **两边各自要满足**：
  - 计时侧（`lib/choreography/timing.ts:118-119`）：`Math.max(MIN_READING_MS, ...)` 是给**有旁白**的页兜底的，改它等于同时改视频导出器与 app 阅读计时器两条路 —— 这个文件是从 `lib/playback/engine.ts` 的 `scheduleReadingTimer` 原样搬来的，两边必须继续同源。
  - 引擎侧（`lib/playback/engine.ts`）：阅读页分支要在**调用计时器之前** return，不得「先排计时器再取消」—— 后者会在快速连翻时留下悬挂的 timer。

### SR-F2.3 阅读页不得渲染无法生效的控件（播放/暂停/进度等）

- **输入**：`<CanvasToolbar readingPage={true} … />`（`components/canvas/canvas-toolbar.tsx`），`readingPage = (currentScene?.actions?.length ?? 0) === 0`。
- **期望**：阅读页上 `showPlayPause = !isLiveSession && !readingPage` ⇒ `false`，因此**不出现** `button[aria-label="Play"]` / `button[aria-label="Pause"]`，也**不出现** `button[aria-label="Auto-play"]`；导航按钮（上一页/下一页）照旧**必须**在。滚轮开关**必须**在（它是这一页唯一真有作用的控件，见 SR-F2.6）。无意义的控件整块不渲染，**不得**留成禁用态/灰化态。
- **失败长什么样**：阅读页上挂着一个按了没反应的大播放键；或把播放键灰掉留在原地；或连导航按钮也一起收走（那这页就翻不出去了）。
- **判据落点**：`tests/components/canvas/canvas-toolbar-reading-page.test.ts`，`describe('CanvasToolbar on a reading page')` 下的 `withholds play/pause and auto-play on a reading page`（`:95`）、`keeps navigation on a reading page — that is the point`（`:102`）、`offers play/pause on a normal narrated page`（`:88`，对照组，确认收的是「阅读页上的」而不是「所有页上的」）。命令：`npx vitest run tests/components/canvas/canvas-toolbar-reading-page.test.ts`。**进度条与播放速度没有判据** —— 这两个控件在 `components/canvas/canvas-toolbar.tsx` 与 `components/canvas/canvas-area.tsx` 里本来就不存在（`grep -n "progress\|Progress"` 两文件均无输出），没有测试断言「不出现」。人工核对方式：打开任一自学页，确认工具栏上只有导航、滚轮开关、音量、全屏，没有播放/暂停、自动播放、进度条、倍速。
- **两边各自要满足**：
  - 工具栏侧（`components/canvas/canvas-toolbar.tsx:166-170`）：判据只能是「这一页有没有可作用对象」，即 `readingPage`；不得按场景类型（`slide`/`quiz`）判 —— 有旁白的 slide 和无旁白的 slide 是同一类型。
  - 舞台侧（`components/canvas/canvas-area.tsx:113`）：传给工具栏的 `readingPage` 必须与引擎用的是同一个判据 `(currentScene?.actions?.length ?? 0) === 0`，两处写法不得漂移。

### SR-F2.4 滚轮、点击、方向键三种输入都必须能翻页

- **输入**：阅读页上的一次滚动（`WheelEvent`，`deltaY > 0`）、一次点击空白、一次 `ArrowRight` / `ArrowDown`。
- **期望**：三种都前进。滚轮与方向键还要能后退（`deltaY < 0` ⇒ `prev`；`ArrowLeft` ⇒ 上一页）。方向键的边界：焦点在 `input`/`textarea`/`select`/`role=slider`/`range`/`contentEditable` 上时**不翻页**，带 `ctrl`/`meta`/`alt` 修饰键时**放行给宿主**。
- **失败长什么样**：滚轮能翻、方向键不能；或方向键在自检页答题框里把页面翻走（学生正在写答案，页面跳了）；或 `Ctrl+←` 被吞掉（宿主的「后退」失效）。
- **判据落点**：滚轮 —— `tests/playback/reading-navigation.test.ts` 的 `scrolls down to the next page and up to the previous one`（`:49`）；滚轮接到舞台这一段 —— `tests/components/canvas/canvas-area-wheel-gate.test.ts` 的 `turns the page on a reading page by default`（`:151`）。方向键 —— `tests/standalone-player/navigation.test.ts` 的 `navigates on Left/Right only, never while typing or with modifiers`（`:42`，断言 `ArrowRight`→`'next'`、`ArrowLeft`→`'previous'`、`ArrowUp`/`ArrowDown`/`PageUp`/`PageDown`/`Home`/`End`/`' '`→`null`、`target:{tagName:'TEXTAREA'}`→`null`、`isContentEditable:true`→`null`、`metaKey:true`→`null`）。命令：`npx vitest run tests/playback/reading-navigation.test.ts tests/components/canvas/canvas-area-wheel-gate.test.ts tests/standalone-player/navigation.test.ts`。**点击翻页暂无自动化判据** —— `components/canvas/canvas-area.tsx:163-172` 的 `handleSlideClick` 阅读页分支走 `onNextSlide()`，但没有测试对该舞台派发 `MouseEvent` 并断言 `onNextSlide` 被调用。**`PlaybackChromeRoot` 的方向键翻页也无专门判据** —— `tests/` 下 `ArrowRight` 只出现在 `tests/standalone-player/navigation.test.ts`。人工核对方式：打开一个自学课，分别用滚轮、点空白、按 `→` 各翻一页；再进自检页把光标放进答题框按 `→`，确认是移动光标而不是翻页。
- **两边各自要满足**：
  - 舞台侧（`components/canvas/canvas-area.tsx:195` `onWheel={handleReadingWheel`、`:163` `handleSlideClick`）：点击只有在 `showControls && !isLiveSession && currentScene.type === 'slide'` 且是阅读页时才翻页，非阅读页的点击归播放/暂停，且要跳过 video 元素区域 —— 不得在演示态或直播里也拿点击翻页。
  - 播放器侧（`components/edit/PlaybackChromeRoot.tsx:1581-1592`、`lib/standalone-player/navigation.ts:53-56`）：方向键的键位表**只有** Left/Right 两个方向（`ArrowUp`/`ArrowDown`/`PageUp`/`PageDown`/`Home`/`End` 留给定长自检页与 PBL 页滚动），两处实现必须同一套键位；`event.preventDefault()` 只在真的翻页时调。

### SR-F2.5 翻页必须去抖，一次物理动作只翻一页

- **输入**：`resolveWheelTurn(deltaY, lastTurnAt, now)`（`lib/playback/reading-navigation.ts`），常量 `WHEEL_TURN_MIN_DELTA = 12`（`:22`）、`WHEEL_TURN_COOLDOWN_MS = 450`（`:29`）。
- **期望**：`|deltaY| < 12` ⇒ `null`（触控板连续发出的微小位移不算手势）；`now - lastTurnAt < 450` ⇒ `null`（冷却窗口内后续事件一律忽略，不论方向）；否则 `deltaY > 0 ? 'next' : 'prev'`。一次物理手势只产生**一次**翻页，事件到达几次都一样。
- **失败长什么样**：一次约 600px 的轻甩按 40px/次算，翻过去十五页；或冷却期内反向滚动被吞掉整整一个窗口（人往回拨却没反应）。
- **判据落点**：`tests/playback/reading-navigation.test.ts`，`describe('resolveWheelTurn')` 下的 `scrolls down to the next page and up to the previous one`（`:49`）、`ignores the tiny deltas a trackpad emits continuously`（`:54`，用 `WHEEL_TURN_MIN_DELTA - 1`）、`accepts only ONE turn per gesture, however many events arrive`（`:62`，用 `WHEEL_TURN_COOLDOWN_MS - 1`）、`does not swallow the opposite direction for a whole cooldown`（`:75`）；舞台那一层还有 `tests/components/canvas/canvas-area-wheel-gate.test.ts` 的 `turns the page on a reading page by default`（`:151`，断言 `-100` 在 450ms 内被吞）。命令：`npx vitest run tests/playback/reading-navigation.test.ts tests/components/canvas/canvas-area-wheel-gate.test.ts`。
- **两边各自要满足**：
  - 判定侧（`lib/playback/reading-navigation.ts`）：`resolveWheelTurn` 必须是**纯函数**，只吃 `(deltaY, lastTurnAt, now)`、不读时钟 —— 否则「450ms」这件事没法测。
  - 舞台侧（`components/canvas/canvas-area.tsx:136`）：`handleReadingWheel` 的顺序固定为 `canTurnPage` 闸 → `innerScrollConsumesWheel` 闸 → `resolveWheelTurn` → 记 latch → `preventDefault`/`stopPropagation` → 翻页；latch 的时间戳必须用**翻页那一刻**的 `now`，不得用事件到达时间以外的值。

### SR-F2.6 滚轮翻页必须可关闭，且关闭后默认行为不被打断

- **输入**：`settings.wheelPageTurn`（`lib/store/settings.ts:129`，持久化键 `:208`，默认 `true` 在 `:292`，写法 `setWheelPageTurn` 在 `:320`）；`canTurnPageOnWheel({showControls, readingPage, isLiveSession, isPendingScene, wheelPageTurn})`。
- **期望**：阅读页上**有**一个开关（`button[aria-label="stage.wheelPageTurn"]`，`aria-pressed` 报 on/off，`components/canvas/canvas-toolbar.tsx:474`），点一次回调一次、写入设置。开关**关掉**后：滚轮翻页一次都不发生（连滚三次 `onNext`/`onPrev` 都不该被调用），且**不得 `preventDefault`** —— 滚轮的默认行为要原样还给宿主。开关**打开**时，页内自己还能滚的区域（长自检页、代码块、可滚面板）优先拿手势，滚到头之后同一手势才翻页（`innerScrollConsumesWheel`，到边容差 `SCROLL_EDGE_SLACK_PX = 1`）。
- **失败长什么样**：关掉之后页面还会翻；或关掉之后连页内滚动也一起死了（`preventDefault` 仍被调）；或开关状态只在当前页有效、翻页就丢；或开关出现在滚轮本来就不翻页的地方（有讲稿页、roundtable 布局）—— 那就是个假控件，倒回 SR-F2.3。
- **判据落点**：`tests/components/canvas/canvas-area-wheel-gate.test.ts`，`describe('CanvasArea wheel page-turn')` 下的 `does nothing at all once the learner switched it off`（`:161`，连滚三次断言 `onNext`/`onPrev` 均未调用）、`hands the gesture to courseware that can still scroll itself`（`:175`，滚到底部后同一手势才翻页）、`shows the switch on a reading page, and writes the setting when clicked`（`:190`，断言 `aria-pressed='true'`）；`tests/playback/reading-navigation.test.ts` 的 `allows the turn on a reading page with the learner switch on`（`:31`）、`obeys the learner's switch — this is the whole point of the setting`（`:35`）、`refuses the turn when the wheel never owned the gesture anyway`（`:40`）；`tests/components/canvas/canvas-toolbar-reading-page.test.ts` 的 `offers the wheel switch on a reading page, and reports it as on/off`（`:117`）、`clicking the wheel switch calls back — the learner can turn it off`（`:127`）、`withholds the wheel switch where the wheel turns nothing`（`:137`）；`tests/playback/wheel-inner-scroll.test.ts`（jsdom，用 `Object.defineProperty` 造 `scrollTop`/`clientHeight`/`scrollHeight` 几何）覆盖页内滚动优先这一半。命令：`npx vitest run tests/components/canvas/canvas-area-wheel-gate.test.ts tests/playback/reading-navigation.test.ts tests/components/canvas/canvas-toolbar-reading-page.test.ts tests/playback/wheel-inner-scroll.test.ts`。**「关掉后不拦默认行为」暂无自动化判据** —— 上述断言里没有 `defaultPrevented`（`grep defaultPrevented tests/components/canvas/` 无命中）；可参照的测法在 `tests/adaptive/page-scroll-boundary.test.ts`（它用 `Event('touchmove')` + `event.defaultPrevented` 判是否拦截默认滚动，但测的是触摸边界，不是滚轮翻页开关）。人工核对方式：关掉开关后在浏览器里对一个长自检页滚轮，确认页面确实滚动、且课程没有翻页。
- **两边各自要满足**：
  - 导航判定侧（`lib/playback/reading-navigation.ts:48-49,65`）：`wheelPageTurn` 是**学习者持久化开关**，`canTurnPageOnWheel` 必须读它；缺省（`undefined`）按「开着」处理（`canvas-toolbar.tsx:170` 的 `wheelPageTurn !== false`），不得反着来。
  - 舞台侧（`components/canvas/canvas-area.tsx:135`）：`canTurnPage` 为假时必须**在最前面 return**，一行 `preventDefault` 都不能执行 —— 这一条是「默认行为不被打断」唯一可靠的实现方式，别指望事后补 `preventDefault`。
