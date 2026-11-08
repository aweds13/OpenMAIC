/**
 * 概念图谱的种子：一份**纯数据 + 纯函数**的内联图。
 *
 * ── 为什么是内联的 ──────────────────────────────────────────────
 *
 * `buildSeedGraph()` 不联网、不读盘、不看环境变量。理由不是洁癖：种子是
 * 整张图的**起点**，它一旦随网络或文件系统变化，同一个 commit 在两台机器上
 * 就会种出两张不同的图，而概念 id 是不可重算的（`c_` + 随机 hex），事后没有
 * 任何办法把两张图对齐。所以外部调研的结论在这里**抄成代码**，并逐条标出处。
 *
 * ── 为什么这些边在这里 ──────────────────────────────────────────
 *
 * 每条边都有一个 `source`，只有五种，各自能说的话不一样：
 *
 * 1. `acm-graph` —— 程天学 ACM 图谱的「语言基础」7 节点链。它是唯一一条
 *    本仓自己用过、节点名就是中文名的先修链，正好当 C++/通用入门的骨架。
 * 2. `exercism-cpp` / `exercism-java` —— `exercises.concept[]` 里的
 *    `prerequisites`，是**课程顺序约束**（做完 A 的练习才来做 B），不是
 *    定义依赖。所以全部 `recommended`，没有一条 `strict`。
 * 3. `cs-math-skill-tree` —— `data/curation/prereqs.txt` 的硬/软先修，
 *    带 `prereq-notes.json` 的课程出处。只抄了**逐字核过的 4 条**。
 * 4. `course-outline` —— 本仓 9 门课自己的页序（`document_scenes.scene_order`）。
 *    这是本地证据：Java 课先讲「变量」再讲「自动提升」，这个顺序不是猜的。
 *    页序同样只是**教学顺序**，所以全部 `recommended`。
 * 5. `cs2023` —— **一条边都没有**。CS2023 语料（Zenodo 22760346）是
 *    「层级大纲」，全库 0 条 prerequisites 边；它的贡献是**命名与归属**
 *    （concept 的 `externalRefs`）和 `contains`（KU→topic 的层级）。
 *    拿它造先修边就是编。
 *
 * ── 为什么不更多 ────────────────────────────────────────────────
 *
 * 「宁少不乱」不是保守，是这张图的下游用法决定的：先修边会被用来判「你
 * 该不该现在学这个」。一对多余的边就多一次错误的拦阻。三条自定的规矩：
 *
 * - **只写能指出处的一条边**。说不出「凭什么」的边不写，哪怕它显然成立
 *   （比如「循环要用到变量」——本库没有一条外部证据，课程页序里也不在一个
 *   单元里，不写）。
 * - **不给同形异义留机会**。别名表里**没有**「构造」这种短词：它在算竞图里
 *   是「构造题」、在 Java 课里是「构造方法」，实测一次按名字匹配错挂了 8 页。
 *   所以本文件里 `oop.constructor` 的别名只有「构造方法 / 构造器 / 构造函数 /
 *   Constructors / constructor」。
 * - **不合并看起来一样的词**。`prog.array`（数组）收了三张外部图的引用，
 *   但「ArrayList」是另一个概念（`java.list`）—— 一个是有界连续内存，一个是
 *   会扩容的容器，合并之后「先学数组再学 ArrayList」这条边就没法写了。
 *
 * 规模实测（`buildSeedGraph()` 的返回值）：见 `.tmp/seed_concepts.mts` 的输出。
 */
import { normalizeConceptName } from './ids';

/** 一个种子概念。落库时 `key` 换成 `newConceptId()`，其余字段进各自的表。 */
export interface SeedConcept {
  /** 种子内部稳定短名（如 `cpp.loop`）。只在本文件与落库脚本里用，不落库。 */
  key: string;
  /** 规范名，落 `xq_concept.canonical_name`。 */
  name: string;
  /** 英文名，落 `xq_concept_alias`（可选）。 */
  nameEn?: string;
  /** `xq_concept.kind`，与表的 CHECK 一致。 */
  kind: 'concept' | 'topic' | 'tool';
  /** 其它叫法，全部落 `xq_concept_alias`。 */
  aliases?: string[];
  /** 外部图坐标，落 `xq_concept_external_ref`。 */
  externalRefs?: { sourceGraph: string; externalId: string }[];
}

/** 一条种子边。`reason` 非空是表的硬约束，这里也在类型上要求必填。 */
export interface SeedEdge {
  /** 前置概念的 key。 */
  from: string;
  /** 后继概念的 key。 */
  to: string;
  relation: 'prereq' | 'contains';
  strength: 'strict' | 'recommended' | 'helpful';
  /** 一句能读的理由（≥10 字，不是占位符）。 */
  reason: string;
  /** 出处：`acm-graph` / `exercism-cpp` / `exercism-java` / `cs-math-skill-tree` / `course-outline` / `cs2023`。 */
  source: string;
}

/** 整张种子图。 */
export interface SeedGraph {
  concepts: SeedConcept[];
  edges: SeedEdge[];
}

/** 概念的 kind 只允许这三种（与 `xq_concept.kind` 的 CHECK 一致）。 */
type Kind = SeedConcept['kind'];

/** 边的 source 只允许这五种；写成联合类型，让拼错在编译期就红。 */
type EdgeSource = 'acm-graph' | 'exercism-cpp' | 'exercism-java' | 'cs-math-skill-tree' | 'course-outline' | 'cs2023';

/** 边的关系与强度，抄表的 CHECK。 */
type Relation = SeedEdge['relation'];
type Strength = SeedEdge['strength'];

/**
 * 造一个概念的简写。只为少写三行样板，字段语义与 `SeedConcept` 完全一致。
 *
 * @param key 种子内部稳定短名（落库时换成 `newConceptId()`）。
 * @param name 规范名（人读的）。
 * @param kind `concept` / `topic` / `tool`。
 * @param extra 其余可选字段（`nameEn` / `aliases` / `externalRefs`）。
 */
function c(key: string, name: string, kind: Kind, extra: Partial<SeedConcept> = {}): SeedConcept {
  return { key, name, kind, ...extra };
}

/**
 * 造一条先修边的简写。`source` 是必填的 —— 没有出处就不许有这条边。
 *
 * @param from 前置概念的 key。
 * @param to 后继概念的 key。
 * @param strength `strict` 只给「不学 A 就定义不了 B」；顺序约束一律 `recommended`。
 * @param reason 一句能读的理由（落库时表上有 `length(btrim(reason)) > 0`）。
 * @param source 出处。
 * @param relation 默认 `prereq`；`contains` 用于「单元/集合包含成员」。
 */
function e(
  from: string,
  to: string,
  strength: Strength,
  reason: string,
  source: EdgeSource,
  relation: Relation = 'prereq',
): SeedEdge {
  return { from, to, relation, strength, reason, source };
}

// ---------------------------------------------------------------------------
// 一、程天学「语言基础」7 节点（source: acm-graph）
// ---------------------------------------------------------------------------
// 节点名就是 `.tmp_graph.json` 的 `id`（那张图的 id 是中文名，不是 slug）。
// `nameEn` 刻意不填：那张图的 `nameEn` 字段其实是中文解说（「变量、输入输出
// 与表达式运算」），填进来会让人以为它是英文名。
const PROG: SeedConcept[] = [
  c('prog.seq', '顺序结构', 'concept', {
    aliases: ['顺序结构', '顺序执行', '表达式与赋值'],
    externalRefs: [{ sourceGraph: 'acm-graph', externalId: '顺序结构' }],
  }),
  c('prog.branch', '分支结构', 'concept', {
    aliases: ['分支结构', '分支', '条件语句', 'if', 'else', 'else if', 'If Statements'],
    externalRefs: [
      { sourceGraph: 'acm-graph', externalId: '分支结构' },
      { sourceGraph: 'exercism-cpp', externalId: 'If Statements' },
    ],
  }),
  c('prog.loop', '循环结构', 'concept', {
    aliases: ['循环结构', '循环', 'Loops', 'for', 'while', 'do-while', '增强 for'],
    externalRefs: [
      { sourceGraph: 'acm-graph', externalId: '循环结构' },
      { sourceGraph: 'exercism-cpp', externalId: 'Loops' },
    ],
  }),
  c('prog.array', '数组', 'concept', {
    aliases: ['数组', 'Arrays', 'Arrays and Vectors', '一维数组', '二维数组'],
    externalRefs: [
      { sourceGraph: 'acm-graph', externalId: '数组' },
      { sourceGraph: 'exercism-java', externalId: 'Arrays' },
      { sourceGraph: 'exercism-cpp', externalId: 'Arrays and Vectors' },
    ],
  }),
  c('prog.string', '字符串', 'concept', {
    aliases: ['字符串', '字符串入门', 'Strings', 'String', 'equals'],
    externalRefs: [
      { sourceGraph: 'acm-graph', externalId: '字符串入门' },
      { sourceGraph: 'exercism-cpp', externalId: 'Strings' },
      { sourceGraph: 'exercism-java', externalId: 'Strings' },
    ],
  }),
  c('prog.func', '函数与递归', 'concept', {
    aliases: ['函数与递归', '函数', '递归', 'Functions', 'function'],
    externalRefs: [
      { sourceGraph: 'acm-graph', externalId: '函数与递归' },
      { sourceGraph: 'exercism-cpp', externalId: 'Functions' },
    ],
  }),
  c('prog.struct', '结构体与STL', 'concept', {
    aliases: ['结构体与STL', '结构体', 'STL', 'struct'],
    externalRefs: [{ sourceGraph: 'acm-graph', externalId: '结构体与STL' }],
  }),
  c('prog.collection', '集合框架', 'concept', {
    aliases: ['集合框架', '集合', 'List', 'Set', 'Map', '迭代器'],
    externalRefs: [{ sourceGraph: 'cs2023', externalId: 'FPL-OOP/Collection classes, iterators' }],
  }),
];

// ---------------------------------------------------------------------------
// 二、C++ 入门（source: exercism-cpp，20 个 concept 名里挑了 9 个）
// ---------------------------------------------------------------------------
// I3 第 178 行逐字给了 20 个名字：Strings, Numbers, Basics, Includes,
// Namespaces, If Statements, Booleans, Headers, Comparisons, Arrays and
// Vectors, Loops, Switch Statements, Classes, References, Enumerations,
// Functions, Pointers, Smart Pointers, Auto, Literals。
// 只用得着 9 个当独立概念：If Statements / Loops / Arrays and Vectors /
// Strings / Functions / Classes 都并进了 prog.* 或 oop.class，因为它们是
// **同一个概念**在不同语言里的叫法，拆开就是同形异义的镜像问题。
const CPP: SeedConcept[] = [
  c('cpp.basics', 'C++ 基本语法', 'concept', {
    nameEn: 'Basics',
    aliases: ['Basics', 'basics', '基本语法'],
    externalRefs: [{ sourceGraph: 'exercism-cpp', externalId: 'Basics' }],
  }),
  c('cpp.namespaces', '命名空间', 'concept', {
    nameEn: 'Namespaces',
    aliases: ['Namespaces', 'namespaces', '命名空间', 'using namespace'],
    externalRefs: [{ sourceGraph: 'exercism-cpp', externalId: 'Namespaces' }],
  }),
  c('cpp.includes', '头文件包含', 'concept', {
    nameEn: 'Includes',
    aliases: ['Includes', 'includes', 'include'],
    externalRefs: [{ sourceGraph: 'exercism-cpp', externalId: 'Includes' }],
  }),
  c('cpp.numbers', '数值类型', 'concept', {
    nameEn: 'Numbers',
    aliases: ['Numbers', 'numbers', '数值类型'],
    externalRefs: [{ sourceGraph: 'exercism-cpp', externalId: 'Numbers' }],
  }),
  c('cpp.booleans', '布尔值', 'concept', {
    nameEn: 'Booleans',
    aliases: ['Booleans', 'booleans', '布尔值', '布尔'],
    externalRefs: [{ sourceGraph: 'exercism-cpp', externalId: 'Booleans' }],
  }),
  c('cpp.comparisons', '比较运算', 'concept', {
    nameEn: 'Comparisons',
    aliases: ['Comparisons', 'comparisons', '比较运算'],
    externalRefs: [{ sourceGraph: 'exercism-cpp', externalId: 'Comparisons' }],
  }),
  c('cpp.headers', '头文件与声明', 'concept', {
    nameEn: 'Headers',
    aliases: ['Headers', 'headers', '头文件'],
    externalRefs: [{ sourceGraph: 'exercism-cpp', externalId: 'Headers' }],
  }),
  c('cpp.references', '引用', 'concept', {
    nameEn: 'References',
    aliases: ['References', 'references', '引用'],
    externalRefs: [{ sourceGraph: 'exercism-cpp', externalId: 'References' }],
  }),
  c('cpp.pointers', '指针', 'concept', {
    nameEn: 'Pointers',
    aliases: ['Pointers', 'pointers', '指针'],
    externalRefs: [{ sourceGraph: 'exercism-cpp', externalId: 'Pointers' }],
  }),
];

// ---------------------------------------------------------------------------
// 三、面向对象（跨语言：Java 第 1/2 天 + Dart 第 3 天 + exercism 两家）
// ---------------------------------------------------------------------------
const OOP: SeedConcept[] = [
  c('oop.class', '类与对象', 'concept', {
    aliases: ['类与对象', '类', '对象', '实例', 'Classes', 'class', 'object'],
    externalRefs: [
      { sourceGraph: 'exercism-java', externalId: 'Classes' },
      { sourceGraph: 'exercism-cpp', externalId: 'Classes' },
      {
        sourceGraph: 'cs2023',
        externalId: 'SDF-Fundamentals/Definition of classes: fields, methods, and constructors',
      },
    ],
  }),
  c('oop.method', '方法与字段', 'concept', {
    aliases: ['方法与字段', '方法', '字段', '方法签名', 'method'],
  }),
  c('oop.constructor', '构造方法', 'concept', {
    aliases: ['构造方法', '构造器', '构造函数', 'Constructors', 'constructor'],
    externalRefs: [{ sourceGraph: 'exercism-java', externalId: 'Constructors' }],
  }),
  c('oop.this', 'this 关键字', 'concept', { aliases: ['this', 'this 关键字'] }),
  c('oop.encapsulation', '封装', 'concept', {
    aliases: ['封装', 'Encapsulation', 'getter', 'setter'],
  }),
  c('oop.inheritance', '继承', 'concept', {
    aliases: ['继承', 'extends', 'Inheritance', 'is-a'],
    externalRefs: [{ sourceGraph: 'exercism-java', externalId: 'Inheritance' }],
  }),
  c('oop.super', 'super 关键字', 'concept', { aliases: ['super', 'super 关键字'] }),
  c('oop.polymorphism', '多态', 'concept', {
    aliases: ['多态', 'Polymorphism', '动态绑定'],
  }),
  c('oop.override', '重写与 @Override', 'concept', {
    aliases: ['@Override', '重写', 'override', 'override 注解'],
  }),
  c('oop.abstract', '抽象类', 'concept', { aliases: ['抽象类', '抽象', 'abstract'] }),
  c('oop.interface', '接口', 'concept', {
    aliases: ['接口', 'Interfaces', 'interface'],
    externalRefs: [{ sourceGraph: 'exercism-java', externalId: 'Interfaces' }],
  }),
];

// ---------------------------------------------------------------------------
// 四、Java 语法与集合（第 2 天 90 页的主力）
// ---------------------------------------------------------------------------
const JAVA: SeedConcept[] = [
  c('java.var', '变量与类型', 'concept', {
    aliases: ['变量与类型', '变量', '类型', 'variable', 'type'],
  }),
  c('java.widening', '自动类型提升', 'concept', {
    aliases: ['自动类型提升', '自动提升', 'widening'],
  }),
  c('java.cast', '强制类型转换', 'concept', {
    aliases: ['强制类型转换', '强制转型', 'cast'],
  }),
  c('java.overflow', '整数溢出', 'concept', { aliases: ['整数溢出', '溢出', 'overflow'] }),
  c('java.op-arith', '算术运算符与自增自减', 'concept', {
    aliases: ['算术运算符', '自增自减', '++i', 'i++'],
  }),
  c('java.op-comparison', '比较运算符', 'concept', {
    aliases: ['比较运算符', '==', '!='],
  }),
  c('java.op-logic', '逻辑运算符与短路', 'concept', {
    aliases: ['逻辑运算符', '短路', '短路求值', '&&', '||'],
  }),
  c('java.bitwise', '位运算', 'concept', { aliases: ['位运算', 'bitwise'] }),
  c('java.ternary', '三元运算符', 'concept', {
    aliases: ['三元运算符', '三元', 'Ternary Operators'],
    externalRefs: [{ sourceGraph: 'exercism-java', externalId: 'Ternary Operators' }],
  }),
  c('java.switch', 'switch 语句', 'concept', {
    aliases: ['switch', 'Switch Statements', 'switch 语句'],
    externalRefs: [
      { sourceGraph: 'exercism-java', externalId: 'Switch Statements' },
      { sourceGraph: 'exercism-cpp', externalId: 'Switch Statements' },
    ],
  }),
  c('java.break-continue', 'break 与 continue', 'concept', {
    aliases: ['break', 'continue', 'break 与 continue'],
  }),
  c('java.exception', '异常与 try/catch', 'concept', {
    aliases: ['异常与 try/catch', '异常', 'Exceptions', 'try/catch', 'try-catch'],
    externalRefs: [
      { sourceGraph: 'exercism-java', externalId: 'Exceptions' },
      { sourceGraph: 'cs2023', externalId: 'SDF-Fundamentals/Exception handling' },
    ],
  }),
  c('java.generics', '泛型', 'concept', {
    aliases: ['泛型', 'Generic Types', 'generics'],
    externalRefs: [{ sourceGraph: 'exercism-java', externalId: 'Generic Types' }],
  }),
  c('java.list', 'ArrayList 与 List', 'concept', {
    aliases: ['ArrayList', 'Lists', '列表'],
    externalRefs: [{ sourceGraph: 'exercism-java', externalId: 'Lists' }],
  }),
  c('java.map', 'HashMap 与 Map', 'concept', {
    // 刻意**不收**「映射」：数学课那个 `math.mapping` 才是「映射」，Java 的 Map
    // 是容器。同形异义，按名字合并会把高数页挂到 HashMap 上。
    aliases: ['HashMap', 'Maps', '键值对'],
    externalRefs: [{ sourceGraph: 'exercism-java', externalId: 'Maps' }],
  }),
  c('java.overloading', '方法重载', 'concept', {
    aliases: ['方法重载', '重载', 'Method Overloading'],
    externalRefs: [{ sourceGraph: 'exercism-java', externalId: 'Method Overloading' }],
  }),
  c('java.lambda', 'Lambda 表达式', 'concept', { aliases: ['Lambda', 'lambda'] }),
  c('java.stream', 'Stream 流水线', 'concept', { aliases: ['Stream', '流式处理', '流水线'] }),
];

// ---------------------------------------------------------------------------
// 五、工具与命令行（第 0 天 28 页 + 第 1 天 22 页）
// ---------------------------------------------------------------------------
const TOOLS: SeedConcept[] = [
  c('tool.git', 'Git', 'tool', { aliases: ['Git', 'git', '版本控制'] }),
  c('git.index', '暂存区与提交链', 'concept', {
    aliases: ['暂存区', '工作区', '提交链', 'git add'],
  }),
  c('git.commit', '提交', 'concept', { aliases: ['提交', 'commit', 'git commit'] }),
  c('git.branch', 'Git 分支', 'concept', { aliases: ['git 分支', 'branch', '分支切换'] }),
  c('git.merge', '合并与冲突', 'concept', { aliases: ['合并', 'merge', '冲突', '三方合并'] }),
  c('git.remote', '远程仓库与 PR', 'concept', {
    aliases: ['远程仓库', 'push', 'pull', 'fetch', 'PR'],
  }),
  c('linux.shell', '命令行与 shell', 'concept', {
    aliases: ['命令行', 'shell', 'bash', '终端'],
    externalRefs: [{ sourceGraph: 'cs2023', externalId: 'FPL-Scripting/System commands' }],
  }),
  c('linux.pipe', '管道与重定向', 'concept', {
    aliases: ['管道', '重定向', '管道与重定向'],
    externalRefs: [{ sourceGraph: 'cs2023', externalId: 'FPL-Scripting/Piping' }],
  }),
  c('linux.path', 'PATH 与环境变量', 'concept', {
    aliases: ['PATH', '环境变量', 'export'],
    externalRefs: [{ sourceGraph: 'cs2023', externalId: 'FPL-Scripting/Environment variables' }],
  }),
  c('linux.permission', '权限与 chmod', 'concept', {
    aliases: ['权限', 'chmod', 'sudo', 'rwx'],
  }),
  c('linux.archive', '手动解压安装', 'concept', { aliases: ['解压', '手动安装', 'tar'] }),
  c('tool.jdk', 'JDK', 'tool', { aliases: ['JDK', 'jdk', 'Java 环境'] }),
  c('tool.maven', 'Maven', 'tool', { aliases: ['Maven', 'maven', 'pom.xml', 'mvn'] }),
  c('tool.flutter', 'Flutter', 'tool', { aliases: ['Flutter', 'flutter', 'SDK'] }),
  c('tool.wsl', 'WSL2 与 Debian', 'tool', { aliases: ['WSL2', 'WSL', 'Debian', 'Linux 发行版'] }),
];

// ---------------------------------------------------------------------------
// 六、Dart / Flutter（第 3 天 36 页 + Dart 第一课 12 页）
// ---------------------------------------------------------------------------
const DART: SeedConcept[] = [
  c('dart.var', 'Dart 变量 var / final / const', 'concept', {
    aliases: ['var', 'final', 'const', 'Dart 变量'],
  }),
  c('dart.nullsafety', '空安全', 'concept', {
    aliases: ['空安全', '可空类型', 'null safety', 'late'],
  }),
  c('dart.named-param', '命名参数与箭头函数', 'concept', {
    aliases: ['命名参数', '箭头函数', '可选参数'],
  }),
  c('dart.async', '异步与 Future', 'concept', {
    aliases: ['异步', 'Future', 'async', 'await'],
  }),
  c('flutter.widget', 'Widget 与组件树', 'concept', {
    aliases: ['Widget', '组件树', 'MaterialApp', 'Scaffold'],
  }),
  c('flutter.stateful', 'Stateless 与 Stateful', 'concept', {
    aliases: ['StatelessWidget', 'StatefulWidget', '无状态', '有状态'],
  }),
  c('flutter.setstate', 'setState 与状态管理', 'concept', {
    aliases: ['setState', '状态管理'],
    externalRefs: [
      {
        sourceGraph: 'cs2023',
        externalId:
          'FPL-Event-Driven/Components of reactive programming: event-source, event signals, listeners and dispatchers',
      },
    ],
  }),
  c('flutter.layout', '布局 Row / Column / Container', 'concept', {
    aliases: ['布局', 'Row', 'Column', 'Container', 'Expanded'],
    externalRefs: [
      { sourceGraph: 'cs2023', externalId: 'SPD-Mobile/Responsive user interface design' },
    ],
  }),
  c('flutter.navigate', '路由与页面跳转', 'concept', {
    aliases: ['路由', 'Navigator', '页面跳转', '命名路由'],
  }),
  c('flutter.cross-platform', '跨平台开发', 'concept', {
    aliases: ['跨平台', '跨平台开发'],
    externalRefs: [
      { sourceGraph: 'cs2023', externalId: 'SPD-Mobile/Native versus cross-platform development' },
    ],
  }),
];

// ---------------------------------------------------------------------------
// 七、数学：本仓课程的「讲」级概念（伴生高数 28 页 + 证明语言 7 页）
// ---------------------------------------------------------------------------
const MATH: SeedConcept[] = [
  c('math.mapping', '对应法则与映射', 'concept', {
    aliases: ['对应法则', '映射', '定义域', '值域'],
  }),
  c('math.injection', '单射、满射、双射', 'concept', { aliases: ['单射', '满射', '双射'] }),
  c('math.inverse-fn', '反函数', 'concept', { aliases: ['反函数'] }),
  c('math.seq-limit', '数列极限与 ε-N', 'concept', {
    aliases: ['数列极限', 'ε-N', 'ε-N 语言'],
    externalRefs: [{ sourceGraph: 'cs2023', externalId: 'MSF-Calculus/Sequences, series, limits' }],
  }),
  c('math.convergence', '收敛数列的性质', 'concept', { aliases: ['收敛数列', '收敛数列的性质'] }),
  c('math.fn-limit', '函数极限与 ε-δ', 'concept', { aliases: ['ε-δ', '函数极限', 'ε-δ 语言'] }),
  c('math.infinity', '无穷大量', 'concept', { aliases: ['无穷大量', '无穷大'] }),
  c('math.continuity', '连续', 'concept', { aliases: ['连续', '连续的定义'] }),
  c('math.discontinuity', '间断点与单侧极限', 'concept', {
    aliases: ['间断点', '单侧极限'],
  }),
  c('math.squeeze', '夹逼定理', 'concept', { aliases: ['夹逼定理', '夹逼'] }),
  c('math.monotone', '单调有界', 'concept', { aliases: ['单调有界', '单调有界定理'] }),
  c('math.equiv-infinitesimal', '等价无穷小', 'concept', {
    aliases: ['等价无穷小', '等价无穷小替换'],
  }),
  c('math.derivative', '导数与可导', 'concept', {
    aliases: ['导数', '可导'],
    externalRefs: [
      {
        sourceGraph: 'cs2023',
        externalId:
          'MSF-Calculus/Single-variable derivatives: definition, computation rules (chain rule etc.)',
      },
    ],
  }),
  c('math.diff-cont', '可导蕴含连续', 'concept', { aliases: ['可导蕴含连续'] }),
  c('math.product-rule', '乘法法则', 'concept', { aliases: ['乘法法则', '乘积法则'] }),
  c('math.quotient-rule', '商法则', 'concept', { aliases: ['商法则'] }),
  c('math.higher-deriv', '高阶导数', 'concept', { aliases: ['高阶导数'] }),
  c('math.proof', '证明与依据', 'concept', {
    aliases: ['证明', '依据', '定理证明'],
    externalRefs: [
      { sourceGraph: 'cs2023', externalId: 'MSF-Discrete/Proof techniques (induction, proof by contradiction)' },
    ],
  }),
  c('math.logic', '逻辑与真值表', 'concept', {
    aliases: ['真值表', '联结词', '推理规则'],
    externalRefs: [
      {
        sourceGraph: 'cs2023',
        externalId: 'MSF-Discrete/Logic: truth tables, connectives (operators), inference rules',
      },
    ],
  }),
];

// ---------------------------------------------------------------------------
// 八、cs-math-skill-tree 的单元级节点（kind: topic）
// ---------------------------------------------------------------------------
// 节点 id 来自 `data/curation/prereqs.txt`（`M.x.y`），名字来自 `prereqs.txt`
// 与调研文件第 95 行逐字给出的节点名。小节级（`M.3.1` 的 5.1/5.2/5.3/2.4）
// 来自同仓 `data/outlines/M.3.1.json` 的 `ref` 字段；它们的 source_graph
// 记成 `cs-math-skill-tree-outline`，因为 `M.3.1/5.3` 这种路径**不是**
// 上游的 external id，是「单元 id + 小节 ref」拼出来的可回查坐标。
const CSMATH: SeedConcept[] = [
  c('cm.M1.1', '极限与连续', 'topic', {
    nameEn: 'Limits & Continuity',
    aliases: ['Limits & Continuity', '极限与连续'],
    externalRefs: [{ sourceGraph: 'cs-math-skill-tree', externalId: 'M.1.1' }],
  }),
  c('cm.M1.2', '单变量微分', 'topic', {
    nameEn: 'Single-Variable Differential Calculus',
    aliases: ['Single-Variable Differential Calculus', '单变量微分'],
    externalRefs: [{ sourceGraph: 'cs-math-skill-tree', externalId: 'M.1.2' }],
  }),
  c('cm.M1.3', '单变量积分', 'topic', {
    nameEn: 'Single-Variable Integral Calculus',
    aliases: ['Single-Variable Integral Calculus', '单变量积分'],
    externalRefs: [{ sourceGraph: 'cs-math-skill-tree', externalId: 'M.1.3' }],
  }),
  c('cm.M1.6', '实分析', 'topic', {
    nameEn: 'Real Analysis',
    aliases: ['Real Analysis', '实分析'],
    externalRefs: [{ sourceGraph: 'cs-math-skill-tree', externalId: 'M.1.6' }],
  }),
  c('cm.M5.2', '数理逻辑', 'topic', {
    nameEn: 'Mathematical Logic',
    aliases: ['Mathematical Logic', '数理逻辑'],
    externalRefs: [{ sourceGraph: 'cs-math-skill-tree', externalId: 'M.5.2' }],
  }),
  c('cm.M5.3', '证明与离散结构', 'topic', {
    nameEn: 'Proofs & Discrete Structures',
    aliases: ['Proofs & Discrete Structures', '证明与离散结构'],
    externalRefs: [{ sourceGraph: 'cs-math-skill-tree', externalId: 'M.5.3' }],
  }),
  c('cm.M3.1', '线性代数', 'topic', {
    nameEn: 'Linear Algebra',
    aliases: ['Linear Algebra', '线性代数'],
    externalRefs: [{ sourceGraph: 'cs-math-skill-tree', externalId: 'M.3.1' }],
  }),
  c('cm.M3.2', '矩阵分析', 'topic', {
    nameEn: 'Matrix Analysis',
    aliases: ['Matrix Analysis', '矩阵分析'],
    externalRefs: [{ sourceGraph: 'cs-math-skill-tree', externalId: 'M.3.2' }],
  }),
  c('cm.M3.1.51', '行列式的性质', 'topic', {
    nameEn: 'The Properties of Determinants',
    aliases: ['行列式的性质'],
    externalRefs: [{ sourceGraph: 'cs-math-skill-tree-outline', externalId: 'M.3.1/5.1' }],
  }),
  c('cm.M3.1.52', '排列与余子式', 'topic', {
    nameEn: 'Permutations and Cofactors',
    aliases: ['排列与余子式'],
    externalRefs: [{ sourceGraph: 'cs-math-skill-tree-outline', externalId: 'M.3.1/5.2' }],
  }),
  c('cm.M3.1.53', 'Cramer 法则、逆矩阵与体积', 'topic', {
    nameEn: "Cramer's Rule, Inverses, and Volumes",
    aliases: ['Cramer 法则', '逆矩阵'],
    externalRefs: [{ sourceGraph: 'cs-math-skill-tree-outline', externalId: 'M.3.1/5.3' }],
  }),
  c('cm.M3.1.24', '矩阵运算规则', 'topic', {
    nameEn: 'Rules for Matrix Operations',
    aliases: ['矩阵运算规则'],
    externalRefs: [{ sourceGraph: 'cs-math-skill-tree-outline', externalId: 'M.3.1/2.4' }],
  }),
  c('cm.M3.1.span', '线性无关、张成与基', 'topic', {
    nameEn: 'Linear independence, span, basis',
    aliases: ['线性无关', '张成', '基'],
    externalRefs: [
      { sourceGraph: 'cs2023', externalId: 'MSF-Linear/Linear independence, span, basis' },
    ],
  }),
  c('cm.M3.1.eigen', '特征值与特征向量', 'topic', {
    nameEn: 'Eigenvectors and eigenvalues',
    aliases: ['特征值', '特征向量'],
    externalRefs: [{ sourceGraph: 'cs2023', externalId: 'MSF-Linear/Eigenvectors and eigenvalues' }],
  }),
];

// ---------------------------------------------------------------------------
// 九、边
// ---------------------------------------------------------------------------

/** 程天学「语言基础」链：6 条，逐条写「为什么必须先学」。 */
const EDGES_ACM: SeedEdge[] = [
  e(
    'prog.seq',
    'prog.branch',
    'strict',
    '分支的条件是一个表达式，没先学会写表达式与赋值，if 后面括号里就无从下笔。',
    'acm-graph',
  ),
  e(
    'prog.branch',
    'prog.loop',
    'strict',
    '循环的继续条件就是一次分支判断；不会写 if，while 的边界一定写成死循环。',
    'acm-graph',
  ),
  e(
    'prog.loop',
    'prog.array',
    'recommended',
    '数组的用法九成是「按下标遍历」，遍历靠循环；不先会循环，数组只能手写十行。',
    'acm-graph',
  ),
  e(
    'prog.array',
    'prog.string',
    'recommended',
    'C 风格字符串本质是字符数组加结尾零，先懂下标与越界，才看得懂字符串为什么这么脆。',
    'acm-graph',
  ),
  e(
    'prog.string',
    'prog.func',
    'recommended',
    '函数的第一批练习都是「传一个字符串进去、返回一个数」，先有字符串这个最常用的入参。',
    'acm-graph',
  ),
  e(
    'prog.func',
    'prog.struct',
    'recommended',
    '结构体排序要写比较函数、STL 的用法大量依赖传参与返回值，先会写函数再谈封装数据。',
    'acm-graph',
  ),
];

/** exercism/cpp 的 8 条（原始 39 条里只有 4 个 exercise 的 prerequisites 被抄下来）。 */
const EDGES_CPP: SeedEdge[] = [
  e(
    'cpp.basics',
    'prog.string',
    'recommended',
    'exercism/cpp 的 log-levels 练习把 basics 列为 strings 的先修：先会读写与函数调用，才动字符串。',
    'exercism-cpp',
  ),
  e(
    'cpp.basics',
    'cpp.includes',
    'recommended',
    'log-levels 同时把 basics 列为 includes 的先修：include 是文件级操作，先有能编译的最小程序。',
    'exercism-cpp',
  ),
  e(
    'cpp.namespaces',
    'prog.string',
    'recommended',
    'log-levels 要求先做 namespaces：std::string 的写法绕不开 std 这个命名空间。',
    'exercism-cpp',
  ),
  e(
    'cpp.namespaces',
    'cpp.includes',
    'recommended',
    'log-levels 把 namespaces 列为 includes 的先修，因为头文件里全是命名空间限定的声明。',
    'exercism-cpp',
  ),
  e(
    'cpp.basics',
    'cpp.numbers',
    'recommended',
    'freelancer-rates 把 basics 列为 numbers 的先修：数值类型要先有变量与表达式才谈得上。',
    'exercism-cpp',
  ),
  e(
    'cpp.includes',
    'cpp.numbers',
    'recommended',
    'freelancer-rates 把 includes 列为 numbers 的先修：算浮点要 <cmath>，不会 include 就没有工具。',
    'exercism-cpp',
  ),
  e(
    'prog.branch',
    'prog.array',
    'recommended',
    'bird-watcher 把 if-else-statements 列为 arrays 的先修：遍历数组的边界处理全靠条件判断。',
    'exercism-cpp',
  ),
];

/** exercism/java 的 4 条（49 条里只有 karls-languages 一个 exercise 的 prerequisites 被抄下来）。 */
const EDGES_JAVA: SeedEdge[] = [
  e(
    'prog.array',
    'java.list',
    'recommended',
    'karls-languages 把 arrays 列为 lists 的先修：ArrayList 是「会扩容的数组」，先懂下标与长度。',
    'exercism-java',
  ),
  e(
    'prog.string',
    'java.list',
    'recommended',
    'karls-languages 把 strings 列为 lists 的先修：那个练习的输入就是一串字符串。',
    'exercism-java',
  ),
  e(
    'prog.array',
    'java.generics',
    'recommended',
    'karls-languages 把 arrays 列为 generic-types 的先修：List<String> 的读法是「装 String 的数组」。',
    'exercism-java',
  ),
  e(
    'prog.string',
    'java.generics',
    'recommended',
    'karls-languages 把 strings 列为 generic-types 的先修：泛型参数最常用的实参就是 String。',
    'exercism-java',
  ),
];

/** 本仓 9 门课的页序证据（`document_scenes.scene_order`）。 */
const EDGES_COURSE: SeedEdge[] = [
  // —— 第 2 天 Java：语法从变量长出来 ——
  e('java.var', 'java.widening', 'recommended', 'Java 课先讲变量与类型，再讲 int + double 为什么得到 double；没有类型就没有提升。', 'course-outline'),
  e('java.widening', 'java.cast', 'recommended', '先懂自动提升的方向，才知道为什么反方向必须显式写 (int) 并会丢精度。', 'course-outline'),
  e('java.var', 'java.op-arith', 'recommended', '自增自减是变量的运算，课上次序是先「变量」第 16 页、后「算术运算符」第 29 页。', 'course-outline'),
  e('java.op-arith', 'java.overflow', 'recommended', '溢出是「两个 15 亿相加」，要先会算再讲算错的边界；课上第 24 页紧跟运算符。', 'course-outline'),
  e('java.var', 'java.op-comparison', 'recommended', '比较运算符的产物是 boolean，先有变量与类型才谈「算出 true/false」。', 'course-outline'),
  e('java.op-comparison', 'java.op-logic', 'recommended', '逻辑运算符把多个比较结果合成一个，课上次序是比较在后、逻辑在前也要先会比较。', 'course-outline'),
  e('java.op-logic', 'prog.branch', 'recommended', 'if 的条件要写 && / || 并理解短路，课上「逻辑运算符」在第 34 页、「条件语句」在第 43 页。', 'course-outline'),
  e('java.var', 'java.bitwise', 'recommended', '位运算要求先把整数想成二进制、知道它的宽度，课上放在类型与溢出之后。', 'course-outline'),
  e('prog.branch', 'java.switch', 'recommended', 'switch 是「一个变量对几个固定值」的分支，课上先 if/else 再 switch 并比较取舍。', 'course-outline'),
  e('prog.branch', 'java.ternary', 'recommended', '三元运算符是 if/else 的表达式写法，先有分支才看得懂求值顺序。', 'course-outline'),
  e('prog.loop', 'java.break-continue', 'recommended', 'break/continue 是循环体里的跳转，课上在 for / while 之后单独一页讲。', 'course-outline'),
  e('java.list', 'java.stream', 'recommended', 'Stream 把集合当流水线，先有 List 才谈流水线的起点。', 'course-outline'),
  e('java.lambda', 'java.stream', 'recommended', '流水线每一步都要传一段行为，课上次序是 Lambda 第 53 页、Stream 第 74 页。', 'course-outline'),
  e('prog.collection', 'java.list', 'recommended', '集合总览先给「List 按顺序、Map 按键找」，再落到具体实现，课上第 48 页在前。', 'course-outline'),
  e('prog.collection', 'java.map', 'recommended', 'HashMap 属于集合总览里的「按键找」，先看总览再学单个容器。', 'course-outline'),
  e('oop.class', 'prog.collection', 'recommended', '集合装的是对象，课上先讲类与对象（第 73 页）再讲集合里装的到底是什么。', 'course-outline'),
  // —— 第 1/2 天 OOP：模板 → 封装 → 继承 → 多态 ——
  e('oop.class', 'oop.method', 'recommended', '类里到底写了哪几行，课上先拆类与对象（第 73 页）再拆字段与方法的结构（第 12 页）。', 'course-outline'),
  e('oop.method', 'oop.constructor', 'recommended', '构造方法是「名字与类相同、没有返回值」的特殊方法，先懂普通方法才看得出它的特殊。', 'course-outline'),
  e('oop.constructor', 'oop.this', 'recommended', 'this 讲的是「指向当前这个对象」，课上紧跟在 new 的那一刻之后（第 14 页 → 第 23 页）。', 'course-outline'),
  e('oop.class', 'oop.encapsulation', 'recommended', '封装是给字段加 private 再开 getter/setter，先有类与字段才封得起来。', 'course-outline'),
  e('oop.class', 'oop.inheritance', 'recommended', '继承是子类拿到父类的字段与方法，课上第 73 页讲类、第 25 页讲 extends。', 'course-outline'),
  e('oop.inheritance', 'oop.super', 'recommended', 'super 调的是父类构造与方法，没有父类就没有 super 可调。', 'course-outline'),
  e('oop.inheritance', 'oop.polymorphism', 'recommended', '多态靠「父类引用指向子类对象」，这句话以继承为前提。', 'course-outline'),
  e('oop.polymorphism', 'oop.override', 'recommended', '动态绑定靠子类重写，课上先讲父类引用（第 81 页）再讲 @Override（第 37 页）。', 'course-outline'),
  e('oop.inheritance', 'oop.abstract', 'recommended', '抽象类是把子类的共性提上来，没有继承的概念就无从「提」。', 'course-outline'),
  e('oop.abstract', 'oop.interface', 'recommended', '课上一页直接对比「接口 vs 抽象类：能做什么，和是什么」，先懂抽象类才分得清两者。', 'course-outline'),
  e('oop.class', 'java.generics', 'recommended', '泛型方法写在类里，课上先有类与对象再写 List<String>。', 'course-outline'),
  // —— 第 0 天环境 → 第 2/3 天语言 ——
  e('tool.wsl', 'linux.shell', 'recommended', '课上第一件事是进 WSL2 的 Debian 再敲命令，没有那个环境就没有命令行可敲。', 'course-outline'),
  e('linux.shell', 'linux.pipe', 'recommended', '管道与重定向是把一条命令的输出接给下一条，前提是已经会敲单条命令。', 'course-outline'),
  e('linux.shell', 'linux.permission', 'recommended', 'ls -l / chmod 是在命令行里读权限位，课上第 13 页的 mkdir/cp/mv 在前。', 'course-outline'),
  e('linux.shell', 'linux.path', 'recommended', 'PATH 解释的是「命令名怎么被找到」，先知道命令是什么再问它从哪来。', 'course-outline'),
  e('linux.archive', 'tool.jdk', 'recommended', '课上装 JDK 的方法是「手动解压再写 PATH」，先会 tar 解压。', 'course-outline'),
  e('linux.path', 'tool.jdk', 'recommended', 'JDK 装完必须写进 PATH 才能全局用；课上把 PATH 单列一页再装 JDK。', 'course-outline'),
  e('linux.archive', 'tool.flutter', 'recommended', 'Flutter 课上的安装也是「依赖 + tar + PATH」，与 JDK 同一条路径。', 'course-outline'),
  e('linux.path', 'tool.flutter', 'recommended', 'flutter 命令找不到是最常见的失败，PATH 没写对；课上先讲 PATH 再讲 flutter doctor。', 'course-outline'),
  e('tool.jdk', 'tool.maven', 'recommended', 'Maven 是 Java 的构建工具，没有 JDK 它跑不起来；课上第 9 页紧跟 JDK。', 'course-outline'),
  e('tool.jdk', 'oop.class', 'recommended', 'HelloWorld 是先编译再运行，课上「装 JDK」第 2 页在「类与对象」第 73 页之前。', 'course-outline'),
  e('java.var', 'oop.class', 'recommended', 'HelloWorld 的逐词拆解里，类体第一行就是变量声明；课上变量在第 16 页、类在第 73 页。', 'course-outline'),
  // —— 第 1 天 Git ——
  e('tool.git', 'git.index', 'recommended', '工作区/暂存区/提交链是 Git 的第一组词，课上第 2 页，先有 Git 才有这三个区。', 'course-outline'),
  e('git.index', 'git.commit', 'recommended', '提交是把暂存区的内容固定下来，没有暂存区就没有「提交什么」的问题。', 'course-outline'),
  e('git.commit', 'git.branch', 'recommended', '分支是一条提交链的指针，先有提交才谈分叉。', 'course-outline'),
  e('git.branch', 'git.merge', 'recommended', '快进/三方合并/冲突都发生在两条分支之间，课上先分支（第 5 页）再 merge（第 6 页）。', 'course-outline'),
  e('git.merge', 'git.remote', 'recommended', '多人协作是「clone → 分支 → push → PR → merge」，本地合并讲完才轮到远端。', 'course-outline'),
  // —— 第 3 天 Dart / Flutter ——
  e('tool.flutter', 'dart.var', 'recommended', 'Dart 是 Flutter 的语言，课上先讲「Dart 是什么、Flutter 为什么用它」再写第一行 Dart。', 'course-outline'),
  e('dart.var', 'dart.nullsafety', 'recommended', '空安全的 ?/!/?? 是加在类型上的修饰，先有 var/final/const 与类型推断。', 'course-outline'),
  e('dart.var', 'dart.named-param', 'recommended', '命名参数与箭头函数都写在函数签名上，课上排在变量与类型之后。', 'course-outline'),
  e('dart.var', 'prog.collection', 'recommended', 'List/Set/Map 里装的是有类型的值，课上「变量与类型」第 7 页在「集合」第 10 页之前。', 'course-outline'),
  e('prog.collection', 'dart.async', 'recommended', 'Future 是「将来才有的一个值」，课上先讲集合与类型再到异步第 22 页。', 'course-outline'),
  e('dart.nullsafety', 'dart.async', 'recommended', 'async/await 的返回值可空性直接决定要不要 ??，空安全是异步的前置。', 'course-outline'),
  e('dart.var', 'oop.class', 'recommended', 'Dart 的类与命名构造要用到 var/final 与类型标注，课上第 14 页在变量第 7 页之后。', 'course-outline'),
  e('flutter.widget', 'flutter.stateful', 'recommended', 'Stateless/Stateful 是两类 Widget，先知道界面是 Widget 拼出来的。', 'course-outline'),
  e('flutter.stateful', 'flutter.setstate', 'recommended', 'setState 只存在于 StatefulWidget 的 State 里，没那个类就没有这个方法。', 'course-outline'),
  e('flutter.stateful', 'flutter.layout', 'recommended', 'Row/Column/Expanded 要放在 Widget 树里才有意义，课上布局在第 31 页、两类 Widget 在第 27 页。', 'course-outline'),
  e('flutter.widget', 'flutter.navigate', 'recommended', 'Navigator.push 推的是一个新的页面 Widget，课上路在第 33 页、Widget 在第 26 页。', 'course-outline'),
  e('flutter.setstate', 'flutter.navigate', 'recommended', '跳页之后回来要重建界面，课上把 setState 与路由放在同一个待办 App 项目里。', 'course-outline'),
  e('tool.flutter', 'flutter.cross-platform', 'recommended', '「Flutter 为什么用 Dart」讲的就是跨平台这条路，课上第 2 页。', 'course-outline'),
  // —— 伴生高数：第一章的链 ——
  e('math.mapping', 'math.injection', 'recommended', '单射/满射/双射是对「对应法则」的分类，课上 1.1 先讲对应法则再讲三个词。', 'course-outline'),
  e('math.injection', 'math.inverse-fn', 'recommended', '反函数存在性靠单射（一一对应），课上把两者放在同一节的例题里。', 'course-outline'),
  e('math.mapping', 'math.seq-limit', 'recommended', '数列是定义域为正整数的映射，课上 1.1 的对应法则先于 1.2 的极限。', 'course-outline'),
  e('math.seq-limit', 'math.convergence', 'recommended', '先有 ε-N 的定义，才谈收敛数列有哪些性质、哪些必须证。', 'course-outline'),
  e('math.seq-limit', 'math.fn-limit', 'recommended', 'ε-δ 是 ε-N 把「n 充分大」换成「x 靠近 a」，课上 1.2 在 1.3 之前。', 'course-outline'),
  e('math.fn-limit', 'math.infinity', 'recommended', '无穷大量是 ∃G 与 ∀n 的顺序问题，与 ε-δ 的量词顺序同构，课上紧跟 1.3。', 'course-outline'),
  e('math.fn-limit', 'math.continuity', 'recommended', '连续的定义比极限少一个「去心」，没有极限定义就写不出连续。', 'course-outline'),
  e('math.continuity', 'math.discontinuity', 'recommended', '间断点分类靠单侧极限，课上 1.4 先定义连续再分类间断。', 'course-outline'),
  e('math.convergence', 'math.squeeze', 'recommended', '夹逼定理证的是「收敛到同一个极限」，前提是已经会判收敛。', 'course-outline'),
  e('math.convergence', 'math.monotone', 'recommended', '单调有界定理的结论是「收敛」，同样要先有收敛的定义。', 'course-outline'),
  e('math.fn-limit', 'math.equiv-infinitesimal', 'recommended', '等价无穷小替换是极限计算里的替换规则，课上 1.6 在极限之后。', 'course-outline'),
  e('math.continuity', 'math.derivative', 'recommended', '导数用极限定义，课上 1.4 连续在 2.1 可导之前。', 'course-outline'),
  e('math.derivative', 'math.diff-cont', 'recommended', '「可导蕴含连续」是第一次用极限定义证结论，先说清导数是什么。', 'course-outline'),
  e('math.derivative', 'math.product-rule', 'recommended', '乘法法则的证明要用导数的定义做展开，课上 2.2 紧跟 2.1。', 'course-outline'),
  e('math.product-rule', 'math.quotient-rule', 'recommended', '商法则由乘法法则加倒数推出，课上的例题直接复用上一页结论。', 'course-outline'),
  e('math.derivative', 'math.higher-deriv', 'recommended', '高阶导数是把求导重复做，先会求一次导。', 'course-outline'),
  e('math.proof', 'math.seq-limit', 'recommended', '证明语言课给的五个工具（量词顺序、机械否定）就是 1.2 起要用的写法。', 'course-outline'),
];

/** cs-math-skill-tree 的 4 条先修（全部逐字核过 prereqs.txt 的行号）。 */
const EDGES_CSMATH: SeedEdge[] = [
  e(
    'cm.M1.3',
    'cm.M1.6',
    'strict',
    '实分析要把微积分的定理严格证明一遍，得先会算；MIT 18.100A 先修 18.02（再往前是 18.01）。',
    'cs-math-skill-tree',
  ),
  e(
    'cm.M5.3',
    'cm.M1.6',
    'strict',
    '整门课都是证明；UCSD MATH 142A 可用 MATH 109（证明方法）作先修。',
    'cs-math-skill-tree',
  ),
  e(
    'cm.M3.1',
    'cm.M3.2',
    'strict',
    '矩阵分析是线性代数的下一步：先把向量空间与对角化做完，才谈矩阵的函数与分解。',
    'cs-math-skill-tree',
  ),
  e(
    'cm.M1.2',
    'cm.M5.3',
    'helpful',
    '软先修：证明与离散结构里的极限论证要借用单变量微分里的连续性直觉，但不上也能学。',
    'cs-math-skill-tree',
  ),
];

/**
 * 层级（`contains`）：单元包含它的小节/主题。这不是先修，是归属，
 * 所以 `strength` 一律 `strict`（大纲里就是这么分的），方向是「大 → 小」。
 */
const EDGES_CONTAINS: SeedEdge[] = [
  e('cm.M3.1', 'cm.M3.1.51', 'strict', 'M.3.1 的小节 5.1，大纲里就在这一章下。', 'cs-math-skill-tree', 'contains'),
  e('cm.M3.1', 'cm.M3.1.52', 'strict', 'M.3.1 的小节 5.2，大纲里就在这一章下。', 'cs-math-skill-tree', 'contains'),
  e('cm.M3.1', 'cm.M3.1.53', 'strict', 'M.3.1 的小节 5.3，大纲里就在这一章下。', 'cs-math-skill-tree', 'contains'),
  e('cm.M3.1', 'cm.M3.1.24', 'strict', 'M.3.1 的小节 2.4，大纲里就在这一章下。', 'cs-math-skill-tree', 'contains'),
  e('cm.M3.1', 'cm.M3.1.span', 'strict', '线性无关/张成/基是线性代数这一单元的核心主题（CS2023 MSF-Linear）。', 'cs2023', 'contains'),
  e('cm.M3.1', 'cm.M3.1.eigen', 'strict', '特征值与特征向量是线性代数这一单元的主题（CS2023 MSF-Linear）。', 'cs2023', 'contains'),
  e('cm.M1.1', 'math.fn-limit', 'strict', '「极限与连续」这个单元装的就是函数极限与连续这两块。', 'cs-math-skill-tree', 'contains'),
  e('cm.M1.1', 'math.continuity', 'strict', '连续属于「极限与连续」单元，课上 1.4 就在这一块。', 'cs-math-skill-tree', 'contains'),
  e('cm.M1.2', 'math.derivative', 'strict', '导数属于「单变量微分」单元。', 'cs-math-skill-tree', 'contains'),
  e('cm.M5.3', 'math.proof', 'strict', '证明与离散结构这一单元装的就是证明方法。', 'cs-math-skill-tree', 'contains'),
  e('cm.M5.2', 'math.logic', 'strict', '数理逻辑这一单元装的是真值表、联结词与推理规则。', 'cs-math-skill-tree', 'contains'),
];

/**
 * 校验并返回整张种子图。
 *
 * 四条自检在返回前跑完，任何一条不过就抛 —— 种子里出现重名、重边或悬空边时，
 * 落库之后再发现就已经污染了真库（概念 id 是随机的，事后无法按名字回滚）：
 *
 * 1. `key` 不许重复；
 * 2. 归一化后的别名不许指向两个概念（否则「按名字找概念」有歧义，
 *    正是「构造」那个坑的形态）；
 * 3. 每条边的 `from` / `to` 都必须在 `concepts` 里，且 `from !== to`；
 * 4. `(from, to, relation)` 不许重复 —— 那是表的主键，重复的那条会被
 *    `ON CONFLICT DO NOTHING` 静默吃掉。
 *
 * @returns 概念 + 边的完整种子图（不含数据库 id）。
 * @throws 上述三条任一条不满足时，错误信息里点名冲突的 key / 别名。
 */
export function buildSeedGraph(): SeedGraph {
  const concepts: SeedConcept[] = [
    ...PROG,
    ...CPP,
    ...OOP,
    ...JAVA,
    ...TOOLS,
    ...DART,
    ...MATH,
    ...CSMATH,
  ];

  const edges: SeedEdge[] = [
    ...EDGES_ACM,
    ...EDGES_CPP,
    ...EDGES_JAVA,
    ...EDGES_COURSE,
    ...EDGES_CSMATH,
    ...EDGES_CONTAINS,
  ];

  const keys = new Set<string>();
  for (const concept of concepts) {
    if (keys.has(concept.key)) {
      throw new Error(`buildSeedGraph: 概念 key 重复 —— ${concept.key}`);
    }
    keys.add(concept.key);
  }

  // 别名唯一性用归一化后的形式判：`String` 与 `string` 必须是同一个入口。
  const aliasOwner = new Map<string, string>();
  for (const concept of concepts) {
    const forms = [concept.name, concept.nameEn, ...(concept.aliases ?? [])];
    for (const form of forms) {
      if (!form) continue;
      const norm = normalizeConceptName(form);
      if (!norm) continue;
      const owner = aliasOwner.get(norm);
      if (owner && owner !== concept.key) {
        throw new Error(`buildSeedGraph: 别名「${form}」同时属于 ${owner} 与 ${concept.key}`);
      }
      aliasOwner.set(norm, concept.key);
    }
  }

  const triple = new Set<string>();
  for (const edge of edges) {
    if (!keys.has(edge.from)) {
      throw new Error(`buildSeedGraph: 边的起点不存在 —— ${edge.from} → ${edge.to}`);
    }
    if (!keys.has(edge.to)) {
      throw new Error(`buildSeedGraph: 边的终点不存在 —— ${edge.from} → ${edge.to}`);
    }
    if (edge.from === edge.to) {
      throw new Error(`buildSeedGraph: 自环边 —— ${edge.from}`);
    }
    // 表的主键是 (from_id, to_id, relation)，同一对概念同一关系只能有一条边。
    // 两条都写出来时后一条会被 `ON CONFLICT DO NOTHING` 静静吃掉 —— 那比报错
    // 更坏：你以为自己加了一条理由，库里却是别人的。这里当场拦下。
    const id = `${edge.from}\u0000${edge.to}\u0000${edge.relation}`;
    if (triple.has(id)) {
      throw new Error(`buildSeedGraph: 重复的边 —— ${edge.from} → ${edge.to} (${edge.relation})`);
    }
    triple.add(id);
  }

  return { concepts, edges };
}
