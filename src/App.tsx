import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Calendar, Check, CheckCircle2,
  ChevronDown, ChevronLeft, ChevronRight, Circle, FilePlus2, FolderKanban, Inbox,
  ListTree, MessageSquare, Plus, RefreshCw, RotateCcw, Send, Sparkles, Star, Target,
  Trash2, Upload, X, Zap,
} from 'lucide-react'
import {
  deleteTask, demoteNode, emptySmart, flattenTasks, initialState, insertSiblingAfter,
  mapTask, newMeta, outlineTemplate, promoteNode, refreshDone, task, uid, withDone,
} from './model'
import type { AppState, ChatMessage, Idea, Project, QuickItem, TaskNode } from './model'
import { decryptJson, encryptJson, type EncryptedSnapshot } from './crypto'
import { pullRemote, pushRemote, type RemoteSnapshot, type SyncConfig } from './sync'
import './App.css'

type View = 'focus' | 'ideas' | 'quick' | 'projects'

function migrateProject(raw: Record<string, unknown>): Project {
  const p: Record<string, unknown> = { ...raw }
  if (p.idea === undefined) p.idea = ''
  if (p.deadline === undefined) p.deadline = ''
  if (p.smart === undefined) p.smart = { s: false, m: false, a: false, r: false }
  if (p.specific !== undefined) {
    const specific = (p.specific as string) || ''
    const measure = (p.measure as string) || ''
    const attainable = (p.attainable as string) || ''
    const relevant = (p.relevant as string) || ''
    p.notes = [p.notes, specific && `具体结果：${specific}`, measure && `衡量标准：${measure}`].filter(Boolean).join('\n')
    p.concerns = [p.concerns, attainable && `可实现边界：${attainable}`, relevant && `值得做的原因：${relevant}`].filter(Boolean).join('\n')
    p.smart = { s: specific ? true : (p.smart as Project['smart']).s, m: measure ? true : (p.smart as Project['smart']).m, a: attainable ? true : (p.smart as Project['smart']).a, r: relevant ? true : (p.smart as Project['smart']).r }
    delete p.specific; delete p.measure; delete p.attainable; delete p.relevant
  }
  if (p.chat === undefined) {
    const chat: ChatMessage[] = []
    if (p.notes) chat.push({ id: uid('msg'), role: 'user', text: `初步构思：${p.notes}`, created: '' })
    if (p.unknowns) chat.push({ id: uid('msg'), role: 'user', text: `还不知道的点：${p.unknowns}`, created: '' })
    if (p.concerns) chat.push({ id: uid('msg'), role: 'user', text: `Concerns：${p.concerns}`, created: '' })
    p.chat = chat
    delete p.notes; delete p.unknowns; delete p.concerns
  }
  return p as unknown as Project
}

function readSyncPoint(): { sha: string; rev: number } | null {
  try { return JSON.parse(localStorage.getItem('xu-flow-sync-point') || 'null') } catch { return null }
}

function loadState(): AppState {
  try {
    const saved = localStorage.getItem('xu-flow-v2')
    if (!saved) return { ...initialState, meta: newMeta() }
    const parsed = JSON.parse(saved)
    delete parsed.focus
    if (Array.isArray(parsed.projects)) parsed.projects = parsed.projects.map(migrateProject)
    if (!parsed.meta) parsed.meta = newMeta()
    return parsed
  } catch { return { ...initialState, meta: newMeta() } }
}

function App() {
  const [view, setView] = useState<View>('focus')
  const [capture, setCapture] = useState('')
  const [captureStar, setCaptureStar] = useState(false)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const captureRef = useRef<HTMLInputElement>(null)

  // —— 同步元数据：任何一次 setState 写入都自动 rev+1、刷新 updatedAt ——
  const [state, setStateRaw] = useState<AppState>(loadState)
  const setState = (updater: AppState | ((prev: AppState) => AppState)) => {
    setStateRaw(prev => {
      const next = typeof updater === 'function' ? (updater as (p: AppState) => AppState)(prev) : updater
      if (next === prev) return prev
      const base = next.meta ?? newMeta()
      return { ...next, meta: { ...base, rev: base.rev + (next.meta ? 1 : 0), updatedAt: new Date().toISOString() } }
    })
  }
  const stateRef = useRef(state)
  stateRef.current = state

  // —— 同步状态 ——
  const [syncCfg, setSyncCfg] = useState<SyncConfig | null>(() => {
    try { return JSON.parse(localStorage.getItem('xu-flow-sync') || 'null') } catch { return null }
  })
  const [syncPw, setSyncPw] = useState('')           // 同步密码：只存内存，刷新后需重新输入
  const [syncOpen, setSyncOpen] = useState(false)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'ok' | 'error' | 'conflict'>('idle')
  const [syncMsg, setSyncMsg] = useState('')
  const [conflict, setConflict] = useState<(RemoteSnapshot & { data: AppState }) | null>(null)
  const applyingRemote = useRef(false)
  const syncPoint = useRef<{ sha: string; rev: number } | null>(readSyncPoint())

  const saveSyncPoint = (sha: string, rev: number) => {
    syncPoint.current = { sha, rev }
    localStorage.setItem('xu-flow-sync-point', JSON.stringify({ sha, rev }))
  }

  const applyRemote = async (remote: RemoteSnapshot) => {
    const data = await decryptJson<AppState>(remote.snapshot, syncPw)
    if (!Array.isArray(data.ideas) || !Array.isArray(data.quick) || !Array.isArray(data.projects)) throw new Error('远端快照格式不对')
    data.projects = data.projects.map(migrateProject)
    if (!data.meta) data.meta = newMeta()
    applyingRemote.current = true
    setStateRaw(data)
    saveSyncPoint(remote.sha, data.meta.rev)
    window.setTimeout(() => { applyingRemote.current = false }, 0)
  }

  const runSync = async () => {
    if (!syncCfg || !syncPw) return
    setSyncStatus('syncing'); setSyncMsg('同步中…')
    try {
      const localEnc = await encryptJson(stateRef.current, syncPw)
      const remote = await pullRemote(syncCfg)
      if (!remote) {
        const r = await pushRemote(syncCfg, null, localEnc)
        if ('ok' in r) { saveSyncPoint(r.sha, stateRef.current.meta?.rev ?? 1); setSyncStatus('ok'); setSyncMsg('已在远端创建第一份快照'); return }
        setConflict({ ...r.remote, data: await decryptJson(r.remote.snapshot, syncPw) }); setSyncStatus('conflict'); setSyncMsg('远端刚被其他设备修改，请选择保留哪一边'); return
      }
      const remoteData = await decryptJson<AppState>(remote.snapshot, syncPw).catch(() => { throw new Error('解密远端失败：同步密码不对？') })
      const localRev = stateRef.current.meta?.rev ?? 1
      const remoteRev = remoteData.meta?.rev ?? 1
      const sp = syncPoint.current
      if (!sp) {
        // 首次配置同步：不做猜测，交给用户二选一
        setConflict({ ...remote, data: remoteData }); setSyncStatus('conflict'); setSyncMsg('首次同步：本地和远端都有数据，请选保留哪一边'); return
      }
      if (remote.sha === sp.sha && localRev === sp.rev) { setSyncStatus('ok'); setSyncMsg('已是最新'); return }
      if (remote.sha === sp.sha) {
        const r = await pushRemote(syncCfg, remote.sha, localEnc)
        if ('ok' in r) { saveSyncPoint(r.sha, localRev); setSyncStatus('ok'); setSyncMsg(`已同步（rev ${localRev}）`); return }
        setConflict({ ...r.remote, data: await decryptJson(r.remote.snapshot, syncPw) }); setSyncStatus('conflict'); setSyncMsg('远端刚被修改，请选择保留哪一边'); return
      }
      if (localRev === sp.rev) { await applyRemote(remote); setSyncStatus('ok'); setSyncMsg(`已采用远端更新（rev ${remoteRev}）`); return }
      setConflict({ ...remote, data: remoteData }); setSyncStatus('conflict'); setSyncMsg('本地和远端都有新改动，请选择保留哪一边')
    } catch (e) { setSyncStatus('error'); setSyncMsg(e instanceof Error ? e.message : '同步失败') }
  }

  // 保存后防抖 5 秒自动同步
  useEffect(() => {
    if (!syncCfg || !syncPw || conflict) return
    const t = window.setTimeout(() => { void runSync() }, 5000)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.meta?.rev, syncCfg, syncPw, conflict])

  // 配置和密码就绪后自动拉取一次
  const syncArmed = useRef(false)
  useEffect(() => {
    if (syncCfg && syncPw && !syncArmed.current) { syncArmed.current = true; void runSync() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncCfg, syncPw])

  const resolveConflict = async (side: 'local' | 'remote') => {
    if (!conflict || !syncCfg) return
    setSyncStatus('syncing'); setSyncMsg('处理冲突…')
    try {
      if (side === 'local') {
        const r = await pushRemote(syncCfg, conflict.sha, await encryptJson(stateRef.current, syncPw))
        if ('ok' in r) { saveSyncPoint(r.sha, stateRef.current.meta?.rev ?? 1); setSyncStatus('ok'); setSyncMsg('已用本地覆盖远端') }
        else { setConflict({ ...r.remote, data: await decryptJson(r.remote.snapshot, syncPw) }); setSyncStatus('conflict'); setSyncMsg('远端又有新改动，再选一次') }
      } else {
        await applyRemote(conflict)
        setSyncStatus('ok'); setSyncMsg('已采用远端版本')
      }
    } catch (e) { setSyncStatus('error'); setSyncMsg(e instanceof Error ? e.message : '处理失败') }
    setConflict(null)
  }

  const exportSnapshotFile = async () => {
    if (!syncPw) { setSyncMsg('先输入同步密码'); return }
    const enc = await encryptJson(stateRef.current, syncPw)
    const blob = new Blob([JSON.stringify(enc, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `do-less-snapshot-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    setSyncMsg('已导出加密快照文件')
  }

  const importSnapshotFile = async (file: File) => {
    if (!syncPw) { setSyncMsg('先输入同步密码'); return }
    try {
      const enc = JSON.parse(await file.text()) as EncryptedSnapshot
      const data = await decryptJson<AppState>(enc, syncPw)
      if (!Array.isArray(data.ideas) || !Array.isArray(data.quick) || !Array.isArray(data.projects)) throw new Error('文件格式不对')
      data.projects = data.projects.map(migrateProject)
      if (!data.meta) data.meta = newMeta()
      setState(data)
      setSyncMsg('已从文件恢复')
    } catch { setSyncMsg('恢复失败：密码不对或文件损坏') }
  }

  useEffect(() => { localStorage.setItem('xu-flow-v2', JSON.stringify(state)) }, [state])
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2500)
    return () => window.clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        event.preventDefault(); captureRef.current?.focus()
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  const activeIdeas = state.ideas.filter(i => !i.routed)
  const activeQuick = state.quick.filter(q => !q.done)
  const activeProjects = state.projects.filter(p => p.active)
  const openProject = state.projects.find(p => p.id === projectId) || null

  const addIdea = () => {
    const text = capture.trim()
    if (!text) return
    setState(s => ({ ...s, ideas: [{ id: uid('idea'), text, starred: captureStar, created: '刚刚', routed: false }, ...s.ideas] }))
    setCapture(''); setCaptureStar(false)
    setToast('收下了，不需要现在决定它是什么')
    captureRef.current?.focus()
  }

  const updateProject = (id: string, patch: Partial<Project>) => {
    setState(s => ({ ...s, projects: s.projects.map(p => p.id === id ? { ...p, ...patch } : p) }))
  }

  const routeToQuick = (idea: Idea) => {
    setState(s => ({
      ...s,
      ideas: s.ideas.map(i => i.id === idea.id ? { ...i, routed: true } : i),
      quick: [...s.quick, { id: uid('quick'), text: idea.text, created: '刚刚', done: false, starred: idea.starred }],
    }))
    setToast('已放到「一次做完」队列末尾')
  }

  const createProject = (idea?: Idea) => {
    const id = uid('project')
    const project: Project = {
      id, title: idea?.text ?? '未命名项目', idea: idea?.text ?? '',
      chat: [], deadline: '', smart: emptySmart(), active: false, tasks: [],
    }
    setState(s => ({
      ...s,
      ideas: idea ? s.ideas.map(i => i.id === idea.id ? { ...i, routed: true } : i) : s.ideas,
      projects: [...s.projects, project],
    }))
    setProjectId(id)
  }

  const toggleProjectActive = (id: string) => {
    const project = state.projects.find(p => p.id === id)
    if (!project) return
    if (!project.active && activeProjects.length >= 3) {
      setToast('当前项目最多 3 个，请先让一个项目退出看板')
      return
    }
    setState(s => ({
      ...s,
      projects: s.projects.map(p => p.id === id ? { ...p, active: !p.active } : p),
    }))
  }

  const completeTask = (projectId: string, taskId: string) => {
    setState(s => ({
      ...s,
      projects: s.projects.map(p => p.id === projectId ? { ...p, tasks: mapTask(p.tasks, taskId, n => ({ ...n, done: true })) } : p),
    }))
    setToast('完成了')
  }

  const sendChat = (projectId: string, text: string) => {
    setState(s => ({
      ...s,
      projects: s.projects.map(p => p.id === projectId ? { ...p, chat: [...(p.chat || []), { id: uid('msg'), role: 'user', text, created: '刚刚' }] } : p),
    }))
    window.setTimeout(() => {
      setState(s => {
        const project = s.projects.find(p => p.id === projectId)
        if (!project) return s
        const { text: reply, patch } = aiChatReply(project, text)
        return { ...s, projects: s.projects.map(p => p.id === projectId ? { ...p, ...patch, chat: [...(p.chat || []), { id: uid('msg'), role: 'ai', text: reply, created: '刚刚' }] } : p) }
      })
    }, 900)
  }

  const aiAsk = (projectId: string) => {
    setState(s => {
      const project = s.projects.find(p => p.id === projectId)
      if (!project) return s
      return { ...s, projects: s.projects.map(p => p.id === projectId ? { ...p, chat: [...(p.chat || []), { id: uid('msg'), role: 'ai', text: smartQuestion(project), created: '刚刚' }] } : p) }
    })
  }

  const reset = () => {
    setState(initialState); setProjectId(null); setView('focus'); setToast('已恢复示例')
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => setView('focus')}><span className="brand-mark">D</span><span>Do less</span></button>
      <div className="side-caption">我的空间</div>
      <nav className="side-nav">
        <button className={view === 'focus' ? 'active' : ''} onClick={() => setView('focus')}><Target size={17} />现在<span>{activeProjects.length}</span></button>
        <button className={view === 'ideas' ? 'active' : ''} onClick={() => setView('ideas')}><Inbox size={17} />Idea 池<span>{activeIdeas.length}</span></button>
        <button className={view === 'quick' ? 'active' : ''} onClick={() => setView('quick')}><Zap size={17} />一次做完<span>{activeQuick.length}</span></button>
        <button className={view === 'projects' ? 'active' : ''} onClick={() => setView('projects')}><FolderKanban size={17} />SMART 项目<span>{state.projects.length}</span></button>
      </nav>
      <div className="sidebar-bottom"><span><i />本地自动保存</span><button onClick={() => setSyncOpen(true)}><RefreshCw size={13} />同步</button><button onClick={reset}><RotateCcw size={13} />重置示例</button></div>
    </aside>

    <main className="main-area">
      <header className="capture-bar">
        <div className="mobile-brand"><span className="brand-mark">D</span>Do less</div>
        <div className="capture-box">
          <button className={captureStar ? 'capture-star starred' : 'capture-star'} aria-label="星标" onClick={() => setCaptureStar(v => !v)}><Star size={17} fill={captureStar ? 'currentColor' : 'none'} /></button>
          <input ref={captureRef} value={capture} onChange={e => setCapture(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addIdea() }} placeholder="一个念头、一个趋势、一本书、任何想做的事……" />
          <kbd>/</kbd><button className="capture-add" disabled={!capture.trim()} onClick={addIdea}><ArrowDown size={16} />收下</button>
        </div>
      </header>
      <nav className="mobile-nav">{(['focus', 'ideas', 'quick', 'projects'] as View[]).map(v => <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>{{ focus: '现在', ideas: 'Idea', quick: '一次做', projects: '项目' }[v]}</button>)}</nav>

      {view === 'focus' && <FocusBoard projects={state.projects} quick={state.quick} onCompleteTask={completeTask} onCompleteQuick={id => setState(s => ({ ...s, quick: s.quick.map(q => q.id === id ? { ...q, done: true } : q) }))} onOpenProject={setProjectId} onOpenQuick={() => setView('quick')} onOpenProjects={() => setView('projects')} />}
      {view === 'ideas' && <IdeaPool ideas={activeIdeas} onStar={id => setState(s => ({ ...s, ideas: s.ideas.map(i => i.id === id ? { ...i, starred: !i.starred } : i) }))} onQuick={routeToQuick} onProject={createProject} />}
      {view === 'quick' && <QuickQueue items={state.quick} onStar={id => setState(s => ({ ...s, quick: s.quick.map(q => q.id === id ? { ...q, starred: !q.starred } : q) }))} onReorder={(id, direction) => setState(s => {
        const active = s.quick.filter(q => !q.done)
        const done = s.quick.filter(q => q.done)
        const index = active.findIndex(q => q.id === id)
        const target = index + direction
        if (target < 0 || target >= active.length) return s
        ;[active[index], active[target]] = [active[target], active[index]]
        return { ...s, quick: [...active, ...done] }
      })} onDone={id => setState(s => ({ ...s, quick: s.quick.map(q => q.id === id ? { ...q, done: true } : q) }))} onDelete={id => setState(s => ({ ...s, quick: s.quick.filter(q => q.id !== id) }))} />}
      {view === 'projects' && <Projects projects={state.projects} onOpen={setProjectId} onNew={() => createProject()} onToggleActive={toggleProjectActive} />}
    </main>

    {openProject && <ProjectEditor project={openProject} activeCount={activeProjects.length} onClose={() => setProjectId(null)} onUpdate={patch => updateProject(openProject.id, patch)} onToggleActive={() => toggleProjectActive(openProject.id)} onSendChat={text => sendChat(openProject.id, text)} onAiAsk={() => aiAsk(openProject.id)} onToast={setToast} />}
    {syncOpen && <SyncPanel
      cfg={syncCfg} onSaveCfg={cfg => { setSyncCfg(cfg); localStorage.setItem('xu-flow-sync', JSON.stringify(cfg)); setSyncMsg('已保存配置'); void runSync() }}
      pw={syncPw} onPw={setSyncPw}
      status={syncStatus} msg={syncMsg}
      onSync={() => void runSync()}
      onExport={() => void exportSnapshotFile()}
      onImport={file => void importSnapshotFile(file)}
      onClose={() => setSyncOpen(false)} />}
    {conflict && <ConflictModal
      localMeta={state.meta} remoteMeta={conflict.data.meta}
      onPick={side => void resolveConflict(side)}
      onExportBoth={() => void exportSnapshotFile()}
      onClose={() => { setConflict(null); setSyncStatus('error'); setSyncMsg('冲突未解决，本次未同步') }} />}
    {toast && <div className="toast"><Check size={15} />{toast}</div>}
  </div>
}

function PageHeading({ eyebrow, title, action }: { eyebrow: string; title: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1></div>{action}</div>
}

function FocusBoard({ projects, quick, onCompleteTask, onCompleteQuick, onOpenProject, onOpenQuick, onOpenProjects }: {
  projects: Project[]
  quick: QuickItem[]
  onCompleteTask: (projectId: string, taskId: string) => void
  onCompleteQuick: (id: string) => void
  onOpenProject: (id: string) => void
  onOpenQuick: () => void
  onOpenProjects: () => void
}) {
  const active = projects.filter(p => p.active)
  const blocks = active.map(project => {
    const leaves = flattenTasks(project.tasks).filter(x => x.node.children.length === 0 && !x.node.done)
    const keyed = leaves.filter(x => x.node.key)
    return { project, shown: (keyed.length > 0 ? keyed : leaves).slice(0, 3), total: leaves.length }
  })
  const undoneQuick = quick.filter(q => !q.done)
  const starredQuick = undoneQuick.filter(q => q.starred)
  const quickShown = (starredQuick.length > 0 ? starredQuick : undoneQuick).slice(0, 3)
  return <section className="focus-view">
    <div className="focus-heading"><span className="eyebrow">RIGHT NOW</span><h1>当前任务</h1></div>
    <div className="board">
      {blocks.map(({ project, shown, total }) => <article className="board-project" key={project.id}>
        <header>
          <button className="board-project-title" onClick={() => onOpenProject(project.id)}>{project.title}</button>
          <span className="board-count">{shown.length}/3 · 还剩 {total} 项</span>
        </header>
        <ul>{shown.map(({ node, path }) => <li key={node.id}>
          <button className="board-check" title="完成" onClick={() => onCompleteTask(project.id, node.id)}><Circle size={19} /></button>
          <button className="board-task" onClick={() => onOpenProject(project.id)}>
            <span>{node.title}</span>
            {path.length > 0 && <small>{path.join(' / ')}</small>}
          </button>
        </li>)}</ul>
        {shown.length === 0 && <div className="board-clear"><CheckCircle2 size={15} />都完成了</div>}
      </article>)}
      {active.length === 0 && <button className="board-empty" onClick={onOpenProjects}><FolderKanban size={18} />选择当前项目</button>}
      <article className="board-project board-quick">
        <header>
          <span className="board-quick-label"><Zap size={14} />闪电任务</span>
          <button className="board-more" onClick={onOpenQuick}>全部<ArrowRight size={12} /></button>
        </header>
        <ul>{quickShown.map(item => <li key={item.id}>
          <button className="board-check" title="完成" onClick={() => onCompleteQuick(item.id)}><Circle size={19} /></button>
          <span className="board-task-text">{item.text}</span>
        </li>)}</ul>
        {quickShown.length === 0 && <div className="board-clear"><CheckCircle2 size={15} />都完成了</div>}
      </article>
    </div>
  </section>
}

function IdeaPool({ ideas, onStar, onQuick, onProject }: { ideas: Idea[]; onStar: (id: string) => void; onQuick: (idea: Idea) => void; onProject: (idea: Idea) => void }) {
  const [filter, setFilter] = useState<'all' | 'starred' | 'plain'>('all')
  const filtered = ideas.filter(i => filter === 'all' || (filter === 'starred' ? i.starred : !i.starred))
  return <section className="content-view"><PageHeading eyebrow="IDEA INBOX" title="Idea 池" />
    <div className="filter-line"><div>{(['all', 'starred', 'plain'] as const).map(f => <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>{f === 'all' ? `全部 ${ideas.length}` : f === 'starred' ? `已星标 ${ideas.filter(i => i.starred).length}` : `未星标 ${ideas.filter(i => !i.starred).length}`}</button>)}</div></div>
    <div className="idea-list">{filtered.map(idea => <article className="idea-row" key={idea.id}>
      <button className={idea.starred ? 'idea-star starred' : 'idea-star'} onClick={() => onStar(idea.id)}><Star size={17} fill={idea.starred ? 'currentColor' : 'none'} /></button>
      <div className="idea-copy"><p>{idea.text}</p><span>{idea.created}</span></div>
      <div className="route-actions"><button onClick={() => onQuick(idea)}><Zap size={14} /><span>一次能做完</span><ArrowRight size={14} /></button><button onClick={() => onProject(idea)}><ListTree size={14} /><span>需要规划</span><ArrowRight size={14} /></button></div>
    </article>)}</div>
    {filtered.length === 0 && <div className="empty-state"><Inbox size={25} /><p>这里现在是空的。</p></div>}
  </section>
}

function QuickQueue({ items, onStar, onReorder, onDone, onDelete }: { items: QuickItem[]; onStar: (id: string) => void; onReorder: (id: string, direction: -1 | 1) => void; onDone: (id: string) => void; onDelete: (id: string) => void }) {
  const active = items.filter(q => !q.done)
  const done = items.filter(q => q.done)
  return <section className="content-view quick-view"><PageHeading eyebrow="ONE-OFF QUEUE" title="一次做完" />
    <div className="quick-list">{active.map((item, index) => <article className={index === 0 ? 'quick-row first' : 'quick-row'} key={item.id}>
      <button className="quick-check" onClick={() => onDone(item.id)}><Circle size={21} /></button><button className={item.starred ? 'queue-star starred' : 'queue-star'} title="星标" onClick={() => onStar(item.id)}><Star size={15} fill={item.starred ? 'currentColor' : 'none'} /></button><span className="queue-index">{String(index + 1).padStart(2, '0')}</span><p>{item.text}</p><span className="queue-time">{item.created}</span><div className="queue-actions"><button disabled={index === 0} onClick={() => onReorder(item.id, -1)}><ArrowUp size={14} /></button><button disabled={index === active.length - 1} onClick={() => onReorder(item.id, 1)}><ArrowDown size={14} /></button><button onClick={() => onDelete(item.id)}><Trash2 size={14} /></button></div>
    </article>)}</div>
    {active.length === 0 && <div className="empty-state"><CheckCircle2 size={26} /><p>一次性事务都处理完了。</p></div>}
    {done.length > 0 && <div className="completed-note"><Check size={14} />已顺手完成 {done.length} 件</div>}
  </section>
}

function smartCount(project: Project) {
  return (project.smart.s ? 1 : 0) + (project.smart.m ? 1 : 0) + (project.smart.a ? 1 : 0) + (project.smart.r ? 1 : 0) + (project.deadline ? 1 : 0)
}

function Projects({ projects, onOpen, onNew, onToggleActive }: { projects: Project[]; onOpen: (id: string) => void; onNew: () => void; onToggleActive: (id: string) => void }) {
  return <section className="content-view"><PageHeading eyebrow="SMART PROJECTS" title="SMART 项目" action={<button className="button primary" onClick={onNew}><Plus size={16} />新建项目</button>} />
    <div className="project-grid">{projects.map(project => {
      const leaves = flattenTasks(project.tasks).filter(x => x.node.children.length === 0)
      const done = leaves.filter(x => x.node.done).length
      const count = smartCount(project)
      return <article className="project-card" key={project.id}>
        <div className="project-card-top"><span className={project.active ? 'active-label on' : 'active-label'}>{project.active ? '进行中' : '未进行'}</span><button onClick={() => onToggleActive(project.id)}>{project.active ? '移出当前' : '设为当前'}<ArrowRight size={13} /></button></div>
        <button className="project-open" onClick={() => onOpen(project.id)}><h2>{project.title}</h2><p>{project.idea || '还没有记录最初的念头。'}</p></button>
        <div className="smart-meter"><div><span>SMART 核验</span><strong>{count}/5</strong></div><i>{[0, 1, 2, 3, 4].map(i => <b key={i} className={i < count ? 'on' : ''} />)}</i></div>
        <div className="project-meta"><span>{project.deadline ? `截止 ${project.deadline}` : '未设截止日期'}</span><span>{done}/{leaves.length} 个末级任务</span></div>
        <button className="open-outline" onClick={() => onOpen(project.id)}>打开完整计划<ArrowRight size={15} /></button>
      </article>
    })}</div>
  </section>
}

function smartSuggestion(title: string, currentDeadline: string) {
  const t = title.trim() || '这件事'
  if (title.includes('视频')) return { title: '拍一条 3 分钟以内的 AI 工具真实使用测评视频并发布', deadline: currentDeadline || '2026-11-15' }
  if (title.includes('读') || title.includes('书')) return { title: '3 周内读完《卡片笔记写作法》，留下 12 条笔记和 1 段 300 字总结', deadline: currentDeadline || '2026-11-30' }
  if (title.includes('习惯')) return { title: '用 21 天验证一个每天 5 分钟的新习惯是否值得保留', deadline: currentDeadline || '2026-11-30' }
  return { title: `把「${t}」收敛成一个 2 周内可交付、能明确判断完成的目标`, deadline: currentDeadline || '2026-11-30' }
}

function pad2(n: number) { return String(n).padStart(2, '0') }
function isoDate(d: Date) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }

// 当前进行到 SMART 的哪一项：0=S 1=M 2=A 3=R 4=T 5=全部通过
function currentSmartStep(project: Project): number {
  if (!project.smart.s) return 0
  if (!project.smart.m) return 1
  if (!project.smart.a) return 2
  if (!project.smart.r) return 3
  if (!project.deadline) return 4
  return 5
}

const SMART_QUESTIONS = [
  '先把它说具体一点：做完这件事，你手里会具体多出什么？（一个作品、一篇文章、一次体验……）',
  '再加一个可以检查的标准：数量、时长或频率是多少？',
  '只做最小版本的话，它最小能小到什么程度？这决定了可不可行。',
  '为什么是现在做它？它和当前最重要的目标有什么关系？',
  '打算什么时候做完？说个日期（比如 11-15 或 11月30日），或点上方截止日期字段选好。',
]

function smartQuestion(project: Project) {
  const step = currentSmartStep(project)
  return step >= 5 ? '五项都核验过了，还有别的顾虑可以直接说。' : SMART_QUESTIONS[step]
}

function cleanLen(t: string) { return t.replace(/[\s，。！？!?.、,…~～—–-]/g, '').length }

function condenseIdea(text: string, fallback: string) {
  const clause = text.split(/[。！？!?\n]/)[0].replace(/^(我)?(就是想|想|打算|计划|准备|我觉得|其实)?/, '').trim()
  const cut = clause.length > 28 ? clause.slice(0, 28) : clause
  return cut.length >= 4 ? cut.replace(/[，,]+$/, '') : fallback
}

function extractMetric(text: string) {
  const m = text.match(/(?:每周|每天|每月)?\s*\d+\s*(?:%|个|条|篇|页|本|次|分钟|小时|天|周|个月|步|版|集|支|回|张)/)
  return m ? m[0].replace(/\s+/g, '') : null
}

function parseChatDate(text: string) {
  const now = new Date()
  let m = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`
  m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/)
  if (m) return `${now.getFullYear()}-${pad2(+m[1])}-${pad2(+m[2])}`
  m = text.match(/(\d{1,2})[-/.](\d{1,2})/)
  if (m) return `${now.getFullYear()}-${pad2(+m[1])}-${pad2(+m[2])}`
  m = text.match(/(\d{1,2})\s*号/)
  if (m) return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(+m[1])}`
  if (/月底|月末/.test(text)) return isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0))
  if (/周[六日天]|周末/.test(text)) {
    const d = new Date(now)
    d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7))
    return isoDate(d)
  }
  if (/下周/.test(text)) { const d = new Date(now); d.setDate(d.getDate() + 7); return isoDate(d) }
  m = text.match(/(\d+)\s*天后/)
  if (m) { const d = new Date(now); d.setDate(d.getDate() + +m[1]); return isoDate(d) }
  return null
}

// 逐项引导 SMART 核验：S/M 改标题，T 填截止日期，A/R 在对话里确认
function aiChatReply(project: Project, text: string): { text: string; patch?: Partial<Project> } {
  const t = text.trim()
  const step = currentSmartStep(project)
  if (/还有|另外|同时|顺便|两件|两件事/.test(t) && step < 5) {
    return { text: '听起来可能不止一件事——建议拆成几个独立项目，各自核验、各自排期。我们先把手上这一件走完。' }
  }
  if (step === 0) {
    if (cleanLen(t) >= 8) {
      const title = condenseIdea(t, project.title)
      return { text: `清楚了，核心是把「${title}」真正做出来。S（具体）核验通过 ✅\n\n下一项 M（可衡量）：数量、时长或频率，做到什么程度算完成？`, patch: { title, smart: { ...project.smart, s: true } } }
    }
    return { text: '还差一点点具体：做完这件事，你手里会多出什么？一个作品、一篇文章，还是一次体验？' }
  }
  if (step === 1) {
    const metric = extractMetric(t)
    if (metric) {
      const base = project.title.split('｜')[0]
      const title = `${base}｜${metric}`
      return { text: `「${metric}」这个标准可以检查，已经写进标题。M（可衡量）核验通过 ✅\n\n下一项 A（可实现）：只做最小版本的话，它最小能小到什么程度？`, patch: { title, smart: { ...project.smart, m: true } } }
    }
    return { text: '还差一个数字：数量、时长或频率，比如「3 分钟」「12 条」「每周 3 次」——是哪一种？' }
  }
  if (step === 2) {
    if (cleanLen(t) >= 6) {
      return { text: '有最小版本的边界就稳了。A（可实现）核验通过 ✅\n\n下一项 R（值得做）：为什么是现在做它？', patch: { smart: { ...project.smart, a: true } } }
    }
    return { text: '还没摸到可行的边界：以接下来的时间和精力，最小版本大概是什么？需要投入多久？' }
  }
  if (step === 3) {
    if (cleanLen(t) >= 6) {
      return project.deadline
        ? { text: `理由说得通。R（值得做）核验通过 ✅\n\n截止日期之前已经选好（${project.deadline}），T（有时限）也已满足——五项全部通过。可以点「AI 拆解项目」，或直接在大纲里写步骤。`, patch: { smart: { ...project.smart, r: true } } }
        : { text: '理由说得通。R（值得做）核验通过 ✅\n\n最后一项 T（有时限）：打算什么时候做完？说个日期（比如 11-15），或点上方截止日期字段选好。', patch: { smart: { ...project.smart, r: true } } }
    }
    return { text: '这个理由还说服不了我：它和当前最重要的目标是什么关系？说不清的话，这个项目可以先往后排。' }
  }
  if (step === 4) {
    const dl = parseChatDate(t)
    if (dl) {
      return { text: `截止日期已写进上方字段：${dl}。T（有时限）核验通过 ✅\n\n五项全部通过。接下来可以点「AI 拆解项目」，或直接在大纲里写步骤。`, patch: { deadline: dl } }
    }
    return { text: '没识别出日期：直接说一个（比如 11-15、11月30日、月底），或点上方截止日期字段选好。' }
  }
  if (/担心|怕|风险|来不及|没时间|坚持不下去|成本/.test(t)) {
    return { text: `收到。最小版本已经定住了，把「${project.title.split('｜')[0]}」限制在最小版内做，这些担心大多可控；真有新风险随时丢到对话里。` }
  }
  if (/怎么|如何|怎样|流程|步骤|先/.test(t)) {
    return { text: '可以在下面大纲里直接列步骤，或点「AI 拆解项目」让我先给一版拆解。' }
  }
  const doneFollowups = ['大纲还有哪里卡住的，直接说。', '需要我把某个节点继续往下拆吗？', '想法有新变化也随时丢进来。']
  return { text: doneFollowups[Math.floor((project.chat?.length ?? 0) / 2) % doneFollowups.length] }
}

function ChatPanel({ chat, thinking, collapsed, onToggle, onSend, onAsk }: {
  chat: ChatMessage[]
  thinking: boolean
  collapsed: boolean
  onToggle: () => void
  onSend: (text: string) => void
  onAsk: () => void
}) {
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }) }, [chat.length, thinking, collapsed])
  if (collapsed) return <button className="chat-collapsed" onClick={onToggle}><MessageSquare size={13} />想法对话{chat.length > 0 && <span>{chat.length}</span>}<ChevronRight size={13} /></button>
  const send = () => {
    const text = input.trim()
    if (!text) return
    onSend(text)
    setInput('')
  }
  return <div className="chat-panel">
    <div className="chat-head">
      <span className="chat-title"><MessageSquare size={13} />想法对话</span>{chat.length > 0 && <span className="chat-count">{chat.length}</span>}
      <div className="chat-head-actions"><button className="chat-ask" onClick={onAsk}><Sparkles size={12} />AI 提问</button><button className="chat-collapse" title="收起" onClick={onToggle}><ChevronLeft size={14} /></button></div>
    </div>
    <div className="chat-list" ref={listRef}>
      {chat.length === 0 && <div className="chat-empty">先讲讲你的具体构思——想做什么、为什么是现在？<br />说完我们一起把它收敛成一个 SMART 项目。</div>}
      {chat.map(m => <div className={`chat-msg ${m.role}`} key={m.id}><p>{m.text}</p></div>)}
      {thinking && <div className="chat-msg ai"><p className="chat-typing"><i /><i /><i /></p></div>}
    </div>
    <div className="chat-input">
      <textarea rows={2} value={input} placeholder="一个疑问、一段担心、一句碎碎念……" onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
      <button className="chat-send" disabled={!input.trim()} onClick={send}><Send size={14} /></button>
    </div>
  </div>
}

function ProjectEditor({ project, activeCount, onClose, onUpdate, onToggleActive, onSendChat, onAiAsk, onToast }: {
  project: Project
  activeCount: number
  onClose: () => void
  onUpdate: (patch: Partial<Project>) => void
  onToggleActive: () => void
  onSendChat: (text: string) => void
  onAiAsk: () => void
  onToast: (text: string) => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [template, setTemplate] = useState('video')
  const [smartOpen, setSmartOpen] = useState(false)
  const [chatCollapsed, setChatCollapsed] = useState(false)
  const [thinking, setThinking] = useState(false)
  const count = smartCount(project)
  const setTasks = (tasks: TaskNode[]) => onUpdate({ tasks: refreshDone(tasks) })
  const focusTask = (id: string) => window.setTimeout(() => {
    const el = document.querySelector<HTMLInputElement>(`input[data-task-id="${id}"]`)
    if (el) { el.focus(); el.select() }
  }, 0)
  const updateTask = (id: string, patch: Partial<TaskNode>) => onUpdate({ tasks: mapTask(project.tasks, id, n => ({ ...n, ...patch })) })
  const toggleTask = (node: TaskNode) => setTasks(mapTask(project.tasks, node.id, n => node.children.length > 0 ? withDone(n, !n.done) : { ...n, done: !n.done }))
  const addChild = (id?: string) => {
    const node = task(uid('task'), '新任务')
    setTasks(id ? mapTask(project.tasks, id, n => ({ ...n, children: [...n.children, node] })) : [...project.tasks, node])
  }
  const removeTask = (id: string) => setTasks(deleteTask(project.tasks, id))
  const onTitleKey = (e: React.KeyboardEvent, node: TaskNode) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const fresh = task(uid('task'), '')
      setTasks(insertSiblingAfter(project.tasks, node.id, fresh))
      focusTask(fresh.id)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const next = e.shiftKey ? promoteNode(project.tasks, node.id) : demoteNode(project.tasks, node.id)
      if (next) { setTasks(next); focusTask(node.id) }
    }
  }
  const aiOutline = (parentId?: string) => {
    const context = [project.title, ...(project.chat || []).map(m => m.text)].join(' ')
    const nodes = parentId ? [task(uid('task'), '收集完成这一步所需的信息'), task(uid('task'), '完成一个最小版本'), task(uid('task'), '检查结果并补齐遗漏')] : outlineTemplate(context.includes('视频') ? 'video' : context.includes('读') || context.includes('书') ? 'reading' : context.includes('习惯') ? 'habit' : 'general')
    setTasks(parentId ? mapTask(project.tasks, parentId, n => ({ ...n, children: [...n.children, ...nodes] })) : [...project.tasks, ...nodes])
    onToast(parentId ? '已为当前节点生成 3 个子任务' : '已结合对话内容生成拆解建议')
  }
  const renderNodes = (nodes: TaskNode[], depth = 0): React.ReactNode => nodes.map(node => {
    const hasChildren = node.children.length > 0
    const isCollapsed = collapsed.has(node.id)
    return <div className="outline-node" key={node.id}>
      <div className={`outline-row ${node.done ? 'done' : ''}`} style={{ '--depth': depth } as React.CSSProperties}>
        <button className="collapse-button" onClick={() => setCollapsed(old => { const copy = new Set(old); if (copy.has(node.id)) copy.delete(node.id); else copy.add(node.id); return copy })}>{hasChildren ? (isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />) : <span />}</button>
        <button className="outline-check" onClick={() => toggleTask(node)}>{node.done ? <CheckCircle2 size={18} /> : <Circle size={18} />}</button>
        <input value={node.title} data-task-id={node.id} placeholder="未命名任务" onChange={e => updateTask(node.id, { title: e.target.value })} onKeyDown={e => onTitleKey(e, node)} />
        <div className="outline-actions">
          {!hasChildren && <button className={node.key ? 'focused' : ''} title={node.key ? '取消关键任务' : '设为关键任务'} onClick={() => updateTask(node.id, { key: !node.key })}><Target size={14} /></button>}
          <button title="添加子任务" onClick={() => addChild(node.id)}><Plus size={14} /></button>
          <button title="AI 继续拆解" onClick={() => aiOutline(node.id)}><Sparkles size={14} /></button>
          <button title="删除" onClick={() => removeTask(node.id)}><Trash2 size={14} /></button>
        </div>
      </div>
      {hasChildren && !isCollapsed && <div>{renderNodes(node.children, depth + 1)}</div>}
    </div>
  })
  return <div className="project-editor">
    <header className="editor-header"><button className="back-button" onClick={onClose}><ArrowLeft size={17} />返回项目</button><div className="editor-header-actions"><span className="ai-demo-note">AI 功能为交互演示</span><button className="smart-button" onClick={() => setSmartOpen(true)}><span className="smart-dots">{[project.smart.s, project.smart.m, project.smart.a, project.smart.r, !!project.deadline].map((on, i) => <i key={i} className={on ? 'on' : ''} />)}</span>SMART {count}/5</button><button className={project.active ? 'button secondary active-project-button' : 'button secondary'} onClick={onToggleActive}>{project.active ? '移出当前项目' : `设为当前项目 ${activeCount}/3`}</button></div></header>
    <section className="idea-block"><span className="eyebrow">IDEA</span>
      <textarea className="idea-text" value={project.idea} onChange={e => onUpdate({ idea: e.target.value })} placeholder="最初的念头，粗糙、模糊都没关系" rows={3} />
    </section>
    <div className="goal-line">
      <input className="goal-title" value={project.title} onChange={e => onUpdate({ title: e.target.value })} placeholder="把想法收敛成一句具体、可衡量的话（S + M 写在这里）" />
      <label className={project.deadline ? 'deadline-chip set' : 'deadline-chip'}><Calendar size={13} /><input type="date" value={project.deadline} onChange={e => onUpdate({ deadline: e.target.value })} /></label>
    </div>
    <div className="workspace">
      <ChatPanel chat={project.chat || []} thinking={thinking} collapsed={chatCollapsed} onToggle={() => setChatCollapsed(v => !v)} onSend={text => { setThinking(true); window.setTimeout(() => setThinking(false), 1100); onSendChat(text) }} onAsk={onAiAsk} />
      <section className="outline-panel"><div className="panel-heading outline-heading"><div><span className="eyebrow">OUTLINE</span><h2>项目大纲</h2></div><button className="ai-button" onClick={() => aiOutline()}><Sparkles size={14} />AI 拆解项目</button></div>
        <div className="template-line"><FilePlus2 size={14} /><span>插入模板</span><select value={template} onChange={e => setTemplate(e.target.value)}><option value="video">视频制作</option><option value="reading">阅读项目</option><option value="habit">习惯养成</option><option value="general">通用项目</option></select><button onClick={() => { onUpdate({ tasks: [...project.tasks, ...outlineTemplate(template)] }); onToast('模板已追加到大纲末尾') }}>插入</button></div>
        <div className="outline-list">{renderNodes(project.tasks)}</div>
        <button className="add-root" onClick={() => addChild()}><Plus size={15} />添加一级节点</button>
      </section>
    </div>
    {smartOpen && <SmartCheck project={project} onClose={() => setSmartOpen(false)} onUpdate={onUpdate} onToast={onToast} />}
  </div>
}

function SmartCheck({ project, onClose, onUpdate, onToast }: {
  project: Project
  onClose: () => void
  onUpdate: (patch: Partial<Project>) => void
  onToast: (text: string) => void
}) {
  const [step, setStep] = useState(() => {
    const pending = ['s', 'm', 'a', 'r'].findIndex(k => !project.smart[k as keyof Project['smart']])
    return pending === -1 ? 4 : pending
  })
  const count = smartCount(project)
  const steps = [
    { key: 's' as const, letter: 'S', name: '具体', question: '完成时，具体会得到什么？', hint: '把结果写进标题，让它具体可见，而不是"了解一下""搞一下"。', done: project.smart.s, onPass: () => onUpdate({ smart: { ...project.smart, s: true } }) },
    { key: 'm' as const, letter: 'M', name: '可衡量', question: '怎样判断它真的完成了？', hint: '标题里最好带数量、时长或一个可检查的标准。', done: project.smart.m, onPass: () => onUpdate({ smart: { ...project.smart, m: true } }) },
    { key: 'a' as const, letter: 'A', name: '可实现', question: '以现在的时间和精力，最小可行版本是什么？', hint: '核验通过即可，答案可以写在上面的「初步构思」里。', done: project.smart.a, onPass: () => onUpdate({ smart: { ...project.smart, a: true } }) },
    { key: 'r' as const, letter: 'R', name: '值得做', question: '为什么现在值得做这件事？', hint: '想不清楚就回到 Idea 或 Concerns，不值得做就删掉。核验通过即可。', done: project.smart.r, onPass: () => onUpdate({ smart: { ...project.smart, r: true } }) },
  ]
  const applyAi = () => {
    const sug = smartSuggestion(project.title, project.deadline)
    onUpdate({ title: sug.title, deadline: sug.deadline, smart: { s: true, m: true, a: true, r: true } })
    onToast('AI 已给出参考，可以继续修改')
  }
  return <div className="modal-layer" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><div className="modal smart-modal"><div className="modal-header"><div><span className="eyebrow">SMART CHECK</span><h2>核验 {count}/5</h2></div><button className="icon-button" onClick={onClose}><X size={17} /></button></div>
    <div className="smart-steps">{steps.map((s, i) => <div className={`smart-step ${s.done ? 'done' : ''} ${i === step ? 'current' : ''}`} key={s.key} onClick={() => { if (!s.done) setStep(i) }}>
      <div className="smart-step-head"><span className="smart-letter">{s.done ? <Check size={12} /> : s.letter}</span><p>{s.name} · {s.question}</p>{s.done && <span>已通过</span>}</div>
      {i === step && !s.done && <div className="smart-step-detail" onClick={e => e.stopPropagation()}>
        <p>{s.hint}</p>
        {(s.key === 's' || s.key === 'm') && <input type="text" value={project.title} onChange={e => onUpdate({ title: e.target.value })} />}
        <div className="smart-step-actions"><button className="pass-button" onClick={() => { s.onPass(); if (step < steps.length) setStep(step + 1) }}>核验通过</button><button className="skip-button" onClick={() => setStep(Math.min(step + 1, steps.length))}>下一条</button></div>
      </div>}
    </div>)}
      <div className={`smart-step ${project.deadline ? 'done' : ''} ${step === steps.length ? 'current' : ''}`} onClick={() => { if (!project.deadline) setStep(steps.length) }}>
        <div className="smart-step-head"><span className="smart-letter">{project.deadline ? <Check size={12} /> : 'T'}</span><p>时限 · 什么时候之前完成？</p>{project.deadline && <span>已设定</span>}</div>
        {step === steps.length && !project.deadline && <div className="smart-step-detail" onClick={e => e.stopPropagation()}>
          <div className="smart-step-actions"><input type="date" value={project.deadline} onChange={e => onUpdate({ deadline: e.target.value })} /><button className="pass-button" disabled={!project.deadline} onClick={onClose}>完成核验</button></div>
        </div>}
      </div></div>
    <div className="smart-modal-footer"><button className="ai-button" onClick={applyAi}><Sparkles size={14} />AI 给一版参考</button><button className="button secondary" onClick={onClose}>关闭</button></div>
  </div></div>
}

function SyncPanel({ cfg, onSaveCfg, pw, onPw, status, msg, onSync, onExport, onImport, onClose }: {
  cfg: SyncConfig | null
  onSaveCfg: (cfg: SyncConfig) => void
  pw: string
  onPw: (v: string) => void
  status: 'idle' | 'syncing' | 'ok' | 'error' | 'conflict'
  msg: string
  onSync: () => void
  onExport: () => void
  onImport: (file: File) => void
  onClose: () => void
}) {
  const [token, setToken] = useState(cfg?.token || '')
  const [repo, setRepo] = useState(cfg?.repo || '')
  const [path, setPath] = useState(cfg?.path || 'do-less/snapshot.enc.json')
  const fileRef = useRef<HTMLInputElement>(null)
  const ready = token.trim() && repo.trim() && path.trim()
  return <div className="modal-layer" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><div className="modal sync-modal"><div className="modal-header"><div><span className="eyebrow">SYNC</span><h2>同步</h2></div><button className="icon-button" onClick={onClose}><X size={17} /></button></div>
    <div className="sync-form">
      <label>同步密码<input type="password" value={pw} placeholder="加密密钥，只保存在本机内存" onChange={e => onPw(e.target.value)} /></label>
      <label>GitHub Token<input type="password" value={token} placeholder="只需仓库读写权限（Contents）" onChange={e => setToken(e.target.value)} /></label>
      <label>仓库（owner/repo）<input type="text" value={repo} placeholder="例如 yourname/do-less-data" onChange={e => setRepo(e.target.value)} /></label>
      <label>快照文件路径<input type="text" value={path} onChange={e => setPath(e.target.value)} /></label>
      <div className="sync-actions">
        <button className="button" disabled={!ready || !pw} onClick={() => onSaveCfg({ token: token.trim(), repo: repo.trim(), path: path.trim() })}><Check size={14} />保存并同步</button>
        <button className="button secondary" onClick={onSync} disabled={!cfg || !pw}>立即同步</button>
      </div>
      <div className="sync-actions">
        <button className="button secondary" onClick={onExport} disabled={!pw}><Upload size={14} />导出加密文件</button>
        <button className="button secondary" onClick={() => fileRef.current?.click()} disabled={!pw}>从文件恢复</button>
        <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = '' }} />
      </div>
      <p className={`sync-status ${status}`}>{status === 'syncing' ? '同步中…' : msg || '配置后自动在保存 5 秒后同步；也可导出加密文件手动搬运。'}</p>
      <p className="sync-note">数据用 AES-GCM 加密后才会离开本机；同步密码不出本机，服务端只见密文。仍建议不要存放敏感个人信息。</p>
    </div>
  </div></div>
}

function ConflictModal({ localMeta, remoteMeta, onPick, onExportBoth, onClose }: {
  localMeta?: { rev: number; updatedAt: string; deviceId: string }
  remoteMeta?: { rev: number; updatedAt: string; deviceId: string }
  onPick: (side: 'local' | 'remote') => void
  onExportBoth: () => void
  onClose: () => void
}) {
  const fmt = (iso: string) => { try { return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch { return '—' } }
  return <div className="modal-layer"><div className="modal conflict-modal"><div className="modal-header"><div><span className="eyebrow">CONFLICT</span><h2>两边都有新改动</h2></div></div>
    <div className="conflict-choices">
      <button className="conflict-choice" onClick={() => onPick('local')}><strong>保留本地</strong><span>rev {localMeta?.rev ?? '—'} · {fmt(localMeta?.updatedAt || '')} · 本机修改</span><em>用本地覆盖远端</em></button>
      <button className="conflict-choice" onClick={() => onPick('remote')}><strong>采用远端</strong><span>rev {remoteMeta?.rev ?? '—'} · {fmt(remoteMeta?.updatedAt || '')} · 另一台设备</span><em>远端覆盖本地</em></button>
    </div>
    <div className="smart-modal-footer"><button className="ai-button" onClick={onExportBoth}>先导出本地快照留底</button><button className="button secondary" onClick={onClose}>暂不处理</button></div>
  </div></div>
}

export default App
