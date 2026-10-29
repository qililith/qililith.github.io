export type Idea = {
  id: string
  text: string
  starred: boolean
  created: string
  routed: boolean
}

export type QuickItem = {
  id: string
  text: string
  created: string
  done: boolean
  starred?: boolean
}

export type TaskNode = {
  id: string
  title: string
  done: boolean
  key?: boolean
  children: TaskNode[]
}

export type ChatMessage = {
  id: string
  role: 'user' | 'ai'
  text: string
  created: string
}

export type Project = {
  id: string
  title: string
  idea: string
  chat: ChatMessage[]
  deadline: string
  smart: { s: boolean; m: boolean; a: boolean; r: boolean }
  active: boolean
  tasks: TaskNode[]
}

export type SyncMeta = {
  rev: number
  updatedAt: string
  deviceId: string
}

export type AppState = {
  ideas: Idea[]
  quick: QuickItem[]
  projects: Project[]
  meta?: SyncMeta
}

export const uid = (prefix = 'item') => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

// 设备 ID：每个浏览器生成一次，长期不变，用于同步时识别"哪台设备改的"
export function getDeviceId(): string {
  let d = localStorage.getItem('xu-flow-device')
  if (!d) { d = uid('dev'); localStorage.setItem('xu-flow-device', d) }
  return d
}

export const newMeta = (): SyncMeta => ({ rev: 1, updatedAt: new Date().toISOString(), deviceId: getDeviceId() })
export const task = (id: string, title: string, children: TaskNode[] = []): TaskNode => ({ id, title, done: false, children })

export const emptySmart = () => ({ s: false, m: false, a: false, r: false })

export function outlineTemplate(kind: string): TaskNode[] {
  if (kind === 'video') return [
    task(uid('task'), '选题', [task(uid('task'), '明确目标观众'), task(uid('task'), '写下 3 个候选选题'), task(uid('task'), '确定唯一核心观点')]),
    task(uid('task'), '脚本', [task(uid('task'), '写出口播初稿'), task(uid('task'), '检查开头 15 秒')]),
    task(uid('task'), '拍摄', [task(uid('task'), '准备场地与设备'), task(uid('task'), '完成 A-roll 拍摄')]),
    task(uid('task'), '剪辑', [task(uid('task'), '完成粗剪'), task(uid('task'), '字幕与声音检查')]),
    task(uid('task'), '审核与发布', [task(uid('task'), '完整回看一遍'), task(uid('task'), '填写标题与简介'), task(uid('task'), '发布')]),
  ]
  if (kind === 'reading') return [
    task(uid('task'), '读前准备', [task(uid('task'), '写下想从书里回答的 3 个问题'), task(uid('task'), '翻目录并划分阅读区段')]),
    task(uid('task'), '分段阅读', [task(uid('task'), '完成第一部分并留下 3 条笔记'), task(uid('task'), '完成第二部分并留下 3 条笔记'), task(uid('task'), '完成剩余章节')]),
    task(uid('task'), '输出与回顾', [task(uid('task'), '写一段 300 字总结'), task(uid('task'), '选择一条可以实践的方法')]),
  ]
  if (kind === 'habit') return [
    task(uid('task'), '定义最小习惯', [task(uid('task'), '确定触发时间与地点'), task(uid('task'), '把行为缩小到 5 分钟以内')]),
    task(uid('task'), '设计环境', [task(uid('task'), '移除一个阻碍'), task(uid('task'), '准备一个显眼提示')]),
    task(uid('task'), '连续实践', [task(uid('task'), '完成第 1 周记录'), task(uid('task'), '完成第 2 周记录'), task(uid('task'), '复盘并决定是否继续')]),
  ]
  return [
    task(uid('task'), '明确结果', [task(uid('task'), '写下完成时应该看到什么')]),
    task(uid('task'), '准备', [task(uid('task'), '收集必要信息与材料')]),
    task(uid('task'), '执行', [task(uid('task'), '完成最小可行版本')]),
    task(uid('task'), '检查与收尾', [task(uid('task'), '对照预期结果检查')]),
  ]
}

export function mapTask(nodes: TaskNode[], id: string, fn: (node: TaskNode) => TaskNode): TaskNode[] {
  return nodes.map(node => node.id === id ? fn(node) : { ...node, children: mapTask(node.children, id, fn) })
}

export function deleteTask(nodes: TaskNode[], id: string): TaskNode[] {
  return nodes.filter(node => node.id !== id).map(node => ({ ...node, children: deleteTask(node.children, id) }))
}

// 在指定节点后面插入一个同级节点
export function insertSiblingAfter(nodes: TaskNode[], id: string, node: TaskNode): TaskNode[] {
  const idx = nodes.findIndex(n => n.id === id)
  if (idx >= 0) return [...nodes.slice(0, idx + 1), node, ...nodes.slice(idx + 1)]
  return nodes.map(n => n.id === id ? n : { ...n, children: insertSiblingAfter(n.children, id, node) })
}

// 降级：成为前一个兄弟的最后一个子任务；没有前一个兄弟则不可降级
export function demoteNode(nodes: TaskNode[], id: string): TaskNode[] | null {
  const idx = nodes.findIndex(n => n.id === id)
  if (idx > 0) {
    const prev = nodes[idx - 1]
    return [
      ...nodes.slice(0, idx - 1),
      { ...prev, children: [...prev.children, nodes[idx]] },
      ...nodes.slice(idx + 1),
    ]
  }
  for (let i = 0; i < nodes.length; i++) {
    const child = demoteNode(nodes[i].children, id)
    if (child) {
      const copy = [...nodes]
      copy[i] = { ...nodes[i], children: child }
      return copy
    }
  }
  return null
}

// 升级：从父任务中移出，排到父任务之后成为其兄弟；没有父任务则不可升级
export function promoteNode(nodes: TaskNode[], id: string): TaskNode[] | null {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    const idx = n.children.findIndex(c => c.id === id)
    if (idx >= 0) {
      const target = n.children[idx]
      const updatedParent = { ...n, children: [...n.children.slice(0, idx), ...n.children.slice(idx + 1)] }
      return [...nodes.slice(0, i), updatedParent, target, ...nodes.slice(i + 1)]
    }
    const child = promoteNode(n.children, id)
    if (child) {
      const copy = [...nodes]
      copy[i] = { ...n, children: child }
      return copy
    }
  }
  return null
}

// 整棵子树统一设置完成状态
export function withDone(node: TaskNode, done: boolean): TaskNode {
  return { ...node, done, children: node.children.map(c => withDone(c, done)) }
}

// 父任务状态自动跟随子任务：所有子任务完成则父任务完成，任一子任务未完成则父任务未完成
export function refreshDone(nodes: TaskNode[]): TaskNode[] {
  return nodes.map(node => {
    const children = refreshDone(node.children)
    return children.length > 0 ? { ...node, children, done: children.every(c => c.done) } : { ...node, children }
  })
}

export function flattenTasks(nodes: TaskNode[], path: string[] = []): { node: TaskNode; path: string[] }[] {
  return nodes.flatMap(node => [
    { node, path },
    ...flattenTasks(node.children, [...path, node.title]),
  ])
}

const videoTasks: TaskNode[] = [
  task('v-topic', '选题', [task('v-audience', '明确目标观众'), task('v-topics', '写下 3 个候选选题'), task('v-angle', '确定唯一核心观点')]),
  task('v-script', '脚本', [task('v-draft', '写出 60 秒口播初稿'), task('v-hook', '检查开头 15 秒')]),
  task('v-shoot', '拍摄', [task('v-setup', '准备场地与设备'), task('v-aroll', '完成 A-roll 拍摄')]),
  task('v-edit', '剪辑', [task('v-rough', '完成粗剪'), task('v-caption', '字幕与声音检查')]),
  task('v-publish', '审核与发布', [task('v-review', '完整回看一遍'), task('v-release', '填写标题、简介并发布')]),
]

const readingTasks: TaskNode[] = [
  task('r-prepare', '读前准备', [task('r-questions', '写下想从书里回答的 3 个问题'), task('r-sections', '翻目录并划分 7 个阅读区段')]),
  task('r-reading', '分段阅读', [{ ...task('r-read', '今晚读完第 1 章的 20 页'), key: true }, task('r-notes', '为第 1 章留下 3 条笔记'), task('r-rest', '完成剩余 6 个阅读区段')]),
  task('r-output', '输出与回顾', [task('r-summary', '写一段 300 字总结'), task('r-practice', '选择一条可以实践的方法')]),
]

export const initialState: AppState = {
  ideas: [
    { id: 'i1', text: 'AI 浏览器会不会改变我收集资料的方式？找个时间试试', starred: true, created: '刚刚', routed: false },
    { id: 'i2', text: '把每周五晚上空出来，不再安排别的事情', starred: false, created: '昨天', routed: false },
    { id: 'i3', text: '了解一下最近大家说的 GEO，可能跟内容工作有关', starred: true, created: '周一', routed: false },
    { id: 'i4', text: '那套很久没用的摄影灯，也许应该出掉', starred: false, created: '上周', routed: false },
  ],
  quick: [
    { id: 'q1', text: '预约周三晚上的牙医', created: '10:12', done: false },
    { id: 'q2', text: '把 AI 浏览器加入待试用列表', created: '11:40', done: false },
    { id: 'q3', text: '回复阿哲关于聚餐的消息', created: '13:05', done: false },
    { id: 'q4', text: '把桌面上的发票拍照存档', created: '15:20', done: false },
  ],
  projects: [
    {
      id: 'p-video', title: '完成一条 3 分钟 AI 工具测评视频', active: true,
      idea: '想拍一条 AI 工具测评视频试试水，看看这种内容形式适不适合自己。具体测哪款、怎么呈现都还没想好。',
      chat: [
        { id: 'm-v1', role: 'user', text: '初步构思：选一款自己真实在用的 AI 工具，完整演示一个真实场景，不做参数罗列，不堆功能清单。', created: '' },
        { id: 'm-v2', role: 'ai', text: '这个方向可行。那完成的时候，你手里会多出什么？比如"一条已经发出去的视频"，还是别的？', created: '' },
      ],
      deadline: '2026-10-31',
      smart: { s: true, m: true, a: false, r: false },
      tasks: videoTasks,
    },
    {
      id: 'p-reading', title: '21 天读完《卡片笔记写作法》', active: true,
      idea: '这本书好像正好能解决我"资料收集很多、真正复用的很少"的问题，想认真读一下。',
      chat: [],
      deadline: '2026-11-15',
      smart: { s: false, m: false, a: false, r: false },
      tasks: readingTasks,
    },
  ],
}
