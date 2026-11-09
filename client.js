/**
 * Prompt Breaker — browser half.
 *
 * A tiny arcade cabinet that rides the live Session event stream:
 *   user/message  → append its characters to the wall
 *   tool/call     → fire one random shot at one surviving character
 *   turn/end      → hold fire when the task is done but bricks remain
 *
 * Everything here is derived from `binding.eventSource`; the Host keeps no
 * game state and the Session log stays the source of truth. The floating card
 * portals to <body> so composer containment and chat scroll cannot clip it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-breaker',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const {
      useCallback, useEffect, useMemo, useReducer, useRef, useState,
    } = React

    const NS = 'prompt-breaker'
    const MAX_BRICKS = 900
    const FLIGHT_MS = 430
    const POS_KEY = 'dsh.prompt-breaker.position.v1'
    const MIN_KEY = 'dsh.prompt-breaker.minimized.v1'
    const PALETTE = [168, 197, 318, 42, 265, 12, 141, 225]
    const NOOP = () => {}

    const ZH = {
      'title': '提示词打砖块',
      'subtitle': 'TOOL-CALL ARCADE',
      'status.idle': '待命',
      'status.running': '开火',
      'status.paused': '暂停',
      'status.celebrate': '清场',
      'stat.shots': '发射',
      'stat.hits': '击碎',
      'stat.left': '残砖',
      'hint.idle': '发一条提示词，砌一面墙',
      'hint.live': '每调用一次工具，随机打掉一个字符',
      'hint.paused': '任务完成，火力待命 · 发新提示词继续',
      'hint.pausedCount': '任务完成，还剩 {count} 块砖',
      'hint.celebrate': '砖墙提前清空，任务仍在继续',
      'hint.trimmed': '+{count} 字未上墙',
      'idle.title': 'READY',
      'idle.hint': '发送提示词，开始砌墙',
      'clear.kicker': 'WALL DEMOLISHED',
      'clear.title': 'ALL CLEAR',
      'clear.hint': '砖墙已清空，等新提示词续杯',
      'minimize': '收起',
      'expand': '展开',
      'aria.region': '提示词打砖块游戏浮窗',
      'aria.board': '提示词砖墙',
      'aria.minimize': '收起游戏浮窗',
      'aria.expand': '展开游戏浮窗',
      'aria.status': '游戏状态：{status}',
    }

    const EN = {
      'title': 'Prompt breaker',
      'subtitle': 'TOOL-CALL ARCADE',
      'status.idle': 'IDLE',
      'status.running': 'LIVE',
      'status.paused': 'PAUSED',
      'status.celebrate': 'CLEAR',
      'stat.shots': 'SHOTS',
      'stat.hits': 'HITS',
      'stat.left': 'LEFT',
      'hint.idle': 'Send a prompt, raise a wall',
      'hint.live': 'Every tool call smashes one random character',
      'hint.paused': 'Task finished · fire held · send a prompt to resume',
      'hint.pausedCount': 'Task finished · {count} bricks still standing',
      'hint.celebrate': 'Wall cleared early · the task is still running',
      'hint.trimmed': '+{count} chars kept off the wall',
      'idle.title': 'READY',
      'idle.hint': 'Send a prompt to start building',
      'clear.kicker': 'WALL DEMOLISHED',
      'clear.title': 'ALL CLEAR',
      'clear.hint': 'Wall cleared · waiting for the next prompt',
      'minimize': 'Minimize',
      'expand': 'Expand',
      'aria.region': 'Prompt breaker game window',
      'aria.board': 'Prompt brick wall',
      'aria.minimize': 'Minimize game window',
      'aria.expand': 'Expand game window',
      'aria.status': 'Game status: {status}',
    }

    const clamp = (value, low, high) => Math.max(low, Math.min(high, value))
    const pad3 = value => String(value).padStart(3, '0')
    const interpolate = (template, params) => {
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (
        name in params ? String(params[name]) : match
      ))
    }

    /** Visible characters of a prompt: one character, one brick. */
    function promptChars(text) {
      return Array.from(String(text ?? '')).filter(ch => !/\s/u.test(ch))
    }

    /** Pull only the human-authored text blocks out of a user/message event. */
    function humanText(event) {
      if (event?.type !== 'user/message') return undefined
      // SessionEventMap['user/message'] is the UserMessage itself, not a wrapper.
      if (event.data?.source?.kind !== 'user') return undefined
      const content = event.data?.content
      if (!Array.isArray(content)) return undefined
      const text = content
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('')
      return text.trim() === '' ? undefined : text
    }

    function emptyState() {
      return {
        bricks: [],
        shots: [],
        hits: [],
        phase: 'idle',
        nextId: 1,
        nextShotId: 1,
        promptCount: 0,
        shotsFired: 0,
        destroyed: 0,
        overflow: 0,
        shakePulse: 0,
        firePulse: 0,
        lastPrompt: '',
        lastTool: '',
      }
    }

    const aliveCount = bricks => bricks.reduce((total, brick) => total + (brick.alive ? 1 : 0), 0)

    function appendPrompt(state, text, now) {
      const chars = promptChars(text)
      if (chars.length === 0) return state
      const promptIndex = state.promptCount + 1
      const baseHue = PALETTE[(promptIndex - 1) % PALETTE.length]
      let nextId = state.nextId
      const fresh = chars.map((ch, offset) => ({
        id: nextId++,
        ch,
        alive: true,
        hue: (baseHue + ((offset * 37) % 26) - 13 + 360) % 360,
        born: now,
      }))
      let bricks = state.bricks.concat(fresh)
      let overflow = state.overflow
      if (bricks.length > MAX_BRICKS) {
        const drop = bricks.length - MAX_BRICKS
        bricks = bricks.slice(drop)
        overflow += drop
      }
      return {
        ...state,
        bricks,
        nextId,
        overflow,
        promptCount: promptIndex,
        phase: 'running',
        lastPrompt: String(text),
      }
    }

    function fireShot(state, toolName, now, burstIndex, viewport) {
      const alive = state.bricks.filter(brick => brick.alive)
      if (alive.length === 0) {
        return { ...state, phase: state.bricks.length > 0 ? 'celebrate' : state.phase }
      }
      const reserved = new Set(state.shots.map(shot => shot.targetId))
      const visible = visibleTargets(state.bricks, viewport)
      const candidates = visible.length > 0 ? visible : alive
      const free = candidates.filter(brick => !reserved.has(brick.id))
      const pool = free.length > 0 ? free : candidates
      const target = pool[Math.floor(Math.random() * pool.length)]
      const delay = Math.min(burstIndex, 8) * 55
      const duration = FLIGHT_MS + Math.floor(Math.random() * 90)
      const shot = {
        id: state.nextShotId,
        targetId: target.id,
        delay,
        duration,
        impactAt: now + delay + duration,
      }
      return {
        ...state,
        shots: state.shots.concat(shot),
        nextShotId: state.nextShotId + 1,
        shotsFired: state.shotsFired + 1,
        firePulse: state.firePulse + 1,
        lastTool: toolName || '',
      }
    }

    function reduce(state, action) {
      switch (action.type) {
        case 'init':
          return action.state
        case 'events': {
          let next = state
          let burstIndex = 0
          for (const event of action.events) {
            if (!event) continue
            if (event.type === 'user/message') {
              const text = humanText(event)
              if (text !== undefined) next = appendPrompt(next, text, action.now)
            } else if (event.type === 'turn/start') {
              if (next.phase !== 'celebrate' && aliveCount(next.bricks) > 0) {
                next = { ...next, phase: 'running' }
              }
            } else if (event.type === 'tool/call') {
              if (next.phase === 'running') {
                next = fireShot(next, event.data?.name, action.now, burstIndex++, action.viewport)
              }
            } else if (event.type === 'turn/end') {
              if (next.bricks.length > 0) {
                next = {
                  ...next,
                  phase: aliveCount(next.bricks) > 0 ? 'paused' : 'celebrate',
                }
              }
            }
          }
          return next
        }
        case 'impact': {
          const shot = state.shots.find(candidate => candidate.id === action.shotId)
          if (shot === undefined) return state
          const target = state.bricks.find(brick => brick.id === shot.targetId)
          const shots = state.shots.filter(candidate => candidate.id !== action.shotId)
          if (target === undefined || !target.alive) {
            return { ...state, shots }
          }
          const bricks = state.bricks.map(brick => (
            brick.id === target.id ? { ...brick, alive: false, died: action.now } : brick
          ))
          const alive = aliveCount(bricks)
          const hit = {
            id: `hit-${shot.id}`,
            brickId: target.id,
            hue: target.hue,
          }
          return {
            ...state,
            bricks,
            shots,
            hits: state.hits.concat(hit).slice(-12),
            destroyed: state.destroyed + 1,
            shakePulse: state.shakePulse + 1,
            phase: alive === 0 && state.phase !== 'idle' ? 'celebrate' : state.phase,
          }
        }
        case 'reset':
          return emptyState()
        default:
          return state
      }
    }

    /** Fold the loaded history once: newest prompt on the wall, historical shots spent. */
    function stateFromHistory(entries) {
      const events = entries
        .filter(entry => entry?.type === 'event' && entry.event)
        .map(entry => entry.event)
        .sort((left, right) => Number(left.seq) - Number(right.seq))
      const maxSeq = events.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0)
      let promptEvent
      for (const event of events) {
        if (humanText(event) !== undefined) promptEvent = event
      }
      let state = emptyState()
      if (promptEvent === undefined) return { state, maxSeq }
      state = appendPrompt(state, humanText(promptEvent), Date.now())
      // Only the newest prompt is restored; tool calls that already happened
      // before the card mounted are not replayed as a volley.
      let phase = 'running'
      for (const event of events) {
        if (Number(event.seq) <= Number(promptEvent.seq)) continue
        if (event.type === 'turn/start') phase = 'running'
        if (event.type === 'turn/end') phase = 'paused'
      }
      state = { ...state, phase }
      return { state, maxSeq }
    }

    function calculateGrid(count, width, height) {
      const fallback = {
        cols: 1, rows: 1, gap: 2, cellW: 24, cellH: 18,
        gridW: 24, gridH: 18, offsetX: Math.max(0, width / 2 - 12),
        offsetY: Math.max(0, height / 2 - 9), fontSize: 12, radius: 3,
      }
      if (count <= 0 || width <= 0 || height <= 0) return fallback
      const gap = count > 640 ? 1 : 2
      let best
      const maxCols = Math.min(count, 96)
      for (let cols = 1; cols <= maxCols; cols++) {
        const rows = Math.ceil(count / cols)
        if (rows > 90) continue
        const rawW = (width - gap * (cols - 1)) / cols
        const rawH = (height - gap * (rows - 1)) / rows
        if (rawW <= 1 || rawH <= 1) continue
        const cellW = Math.min(rawW, 34)
        const cellH = Math.min(rawH, 22)
        const score = Math.min(cellW / 1.25, cellH)
        // Sparse walls hit the cell caps and tie. Prefer a compact, slightly
        // landscape block (roughly 1.7:1) over one very long row or column.
        const shapePenalty = Math.abs(Math.log((cols / rows) / 1.7))
        if (
          best === undefined
          || score > best.score + 0.05
          || (Math.abs(score - best.score) <= 0.05 && shapePenalty < best.shapePenalty)
        ) {
          best = { cols, rows, cellW, cellH, score, shapePenalty }
        }
      }
      if (best === undefined) return fallback
      const gridW = best.cols * best.cellW + gap * (best.cols - 1)
      const gridH = best.rows * best.cellH + gap * (best.rows - 1)
      return {
        cols: best.cols,
        rows: best.rows,
        gap,
        cellW: best.cellW,
        cellH: best.cellH,
        gridW,
        gridH,
        offsetX: Math.max(0, (width - gridW) / 2),
        offsetY: Math.max(0, (height - gridH) / 2),
        fontSize: clamp(Math.min(best.cellW * 0.74, best.cellH * 0.76), 3, 15),
        radius: clamp(Math.min(best.cellW, best.cellH) * 0.18, 1, 4),
      }
    }

    function pointOf(index, grid) {
      if (index < 0 || grid.cols <= 0) return { x: 50, y: 50 }
      const col = index % grid.cols
      const row = Math.floor(index / grid.cols)
      const x = grid.offsetX + col * (grid.cellW + grid.gap) + grid.cellW / 2
      const y = grid.offsetY + row * (grid.cellH + grid.gap) + grid.cellH / 2
      return {
        x: grid.gridW > 0 ? (x / (grid.offsetX * 2 + grid.gridW)) * 100 : 50,
        y: grid.gridH > 0 ? (y / (grid.offsetY * 2 + grid.gridH)) * 100 : 50,
      }
    }

    /** Pixel rectangle of one grid cell, used for line-of-sight tests. */
    function rectOf(index, grid) {
      const col = index % grid.cols
      const row = Math.floor(index / grid.cols)
      const left = grid.offsetX + col * (grid.cellW + grid.gap)
      const top = grid.offsetY + row * (grid.cellH + grid.gap)
      return { left, top, right: left + grid.cellW, bottom: top + grid.cellH }
    }

    /** Liang-Barsky segment/rectangle intersection with a little inflation. */
    function segmentHitsRect(x1, y1, x2, y2, rect, pad) {
      const dx = x2 - x1
      const dy = y2 - y1
      const left = rect.left - pad
      const right = rect.right + pad
      const top = rect.top - pad
      const bottom = rect.bottom + pad
      let t0 = 0
      let t1 = 1
      const edges = [
        [-dx, x1 - left],
        [dx, right - x1],
        [-dy, y1 - top],
        [dy, bottom - y1],
      ]
      for (const [p, q] of edges) {
        if (p === 0) {
          if (q < 0) return false
          continue
        }
        const r = q / p
        if (p < 0) {
          if (r > t1) return false
          if (r > t0) t0 = r
        } else {
          if (r < t0) return false
          if (r < t1) t1 = r
        }
      }
      return t0 <= t1
    }

    /**
     * Only expose bricks the barrel can actually see: a brick behind another
     * surviving brick (on the straight line from the muzzle) is not a target.
     * This makes the wall fall from its exposed bottom edge instead of letting
     * bullets tunnel through the lower rows into its middle.
     */
    function visibleTargets(bricks, viewport) {
      const alive = []
      bricks.forEach((brick, index) => {
        if (brick.alive) alive.push({ brick, index })
      })
      const width = Number(viewport?.width)
      const height = Number(viewport?.height)
      if (alive.length === 0 || !(width > 0) || !(height > 0)) {
        return alive.map(entry => entry.brick)
      }
      const grid = calculateGrid(bricks.length, width, height)
      const originX = width / 2
      // The barrel tip sits in the gap below the wall, so visibility is
      // evaluated from a point slightly below the brick field.
      const originY = height + 22
      const pad = Math.min(1.2, grid.gap * 0.5 + 0.15)
      const result = []
      for (const { brick, index } of alive) {
        const center = pointOf(index, grid)
        const targetX = (center.x / 100) * width
        const targetY = (center.y / 100) * height
        let blocked = false
        for (const other of alive) {
          if (other.index === index) continue
          if (segmentHitsRect(originX, originY, targetX, targetY, rectOf(other.index, grid), pad)) {
            blocked = true
            break
          }
        }
        if (!blocked) result.push(brick)
      }
      return result.length > 0 ? result : alive.map(entry => entry.brick)
    }

    function loadPosition() {
      try {
        const raw = window.localStorage.getItem(POS_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (typeof parsed?.x !== 'number' || typeof parsed?.y !== 'number') return null
        return { x: parsed.x, y: parsed.y }
      } catch {
        return null
      }
    }

    function savePosition(position) {
      try {
        window.localStorage.setItem(POS_KEY, JSON.stringify(position))
      } catch {
        // A privacy mode that refuses storage simply gives up persistence.
      }
    }

    function loadMinimized() {
      try {
        return window.localStorage.getItem(MIN_KEY) === '1'
      } catch {
        return false
      }
    }

    function saveMinimized(value) {
      try {
        window.localStorage.setItem(MIN_KEY, value ? '1' : '0')
      } catch {
        // Ignore storage refusal.
      }
    }

    function PromptBreaker({ sessionId, binding, t }) {
      const [state, dispatch] = useReducer(reduce, undefined, emptyState)
      const [wallSize, setWallSize] = useState({ width: 430, height: 190 })
      const [shotFrame, setShotFrame] = useState({
        wallLeft: 9,
        wallTop: 8,
        wallWidth: 430,
        wallHeight: 166,
        fieldWidth: 448,
        fieldHeight: 224,
      })
      const [minimized, setMinimized] = useState(loadMinimized)
      const [position, setPosition] = useState(loadPosition)
      const [shake, setShake] = useState(false)
      const [aim, setAim] = useState(0)
      const wallRef = useRef(null)
      const playfieldRef = useRef(null)
      const cardRef = useRef(null)
      const dragRef = useRef(null)
      const impactTimers = useRef(new Map())
      const shakeTimer = useRef(undefined)
      const initialized = useRef(false)
      const lastSeq = useRef(0)
      const viewportRef = useRef(wallSize)
      viewportRef.current = wallSize

      const tr = useCallback((key, params) => {
        if (typeof t === 'function') return t(key, params)
        const dict = (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh'))
          ? ZH
          : EN
        return interpolate(dict[key] ?? EN[key] ?? key, params)
      }, [t])

      const toggleMinimized = useCallback(() => {
        setMinimized((current) => {
          const next = !current
          saveMinimized(next)
          return next
        })
      }, [])

      // Follow the live session window. Historical events establish the wall;
      // only events after that fold may fire bullets.
      useEffect(() => {
        initialized.current = false
        lastSeq.current = 0
        dispatch({ type: 'reset' })
        if (binding === undefined || binding === null) return NOOP
        const source = binding.eventSource
        if (source === undefined) return NOOP

        const sync = () => {
          let snapshot
          try {
            snapshot = source.getSnapshot()
          } catch {
            return
          }
          const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : []
          const events = entries
            .filter(entry => entry?.type === 'event' && entry.event)
            .map(entry => entry.event)
          if (!initialized.current) {
            if (events.length === 0) return
            const { state: initial, maxSeq } = stateFromHistory(entries)
            initialized.current = true
            lastSeq.current = maxSeq
            dispatch({ type: 'init', state: initial })
            return
          }
          const fresh = events.filter(event => (Number(event.seq) || 0) > lastSeq.current)
          if (fresh.length === 0) return
          lastSeq.current = fresh.reduce((max, event) => Math.max(max, Number(event.seq) || 0), lastSeq.current)
          dispatch({
            type: 'events',
            events: fresh,
            now: Date.now(),
            viewport: viewportRef.current,
          })
        }

        sync()
        const stop = source.subscribe(sync)
        return stop
      }, [binding])

      // Size the wall from its actual box so the brick grid breathes with the
      // viewport and never spills outside the card.
      useEffect(() => {
        const element = wallRef.current
        if (element === null || minimized) return NOOP
        const measure = () => {
          const rect = element.getBoundingClientRect()
          const field = playfieldRef.current?.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            setWallSize({ width: rect.width, height: rect.height })
          }
          if (field !== undefined && field.width > 0 && field.height > 0) {
            setShotFrame({
              wallLeft: rect.left - field.left,
              wallTop: rect.top - field.top,
              wallWidth: rect.width,
              wallHeight: rect.height,
              fieldWidth: field.width,
              fieldHeight: field.height,
            })
          }
        }
        measure()
        if (typeof ResizeObserver === 'undefined') return NOOP
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        return () => observer.disconnect()
      }, [minimized])

      // Impact is a timed consequence of the flight animation, not a second
      // random draw: each tool call owns exactly one brick.
      useEffect(() => {
        const now = Date.now()
        for (const shot of state.shots) {
          if (impactTimers.current.has(shot.id)) continue
          const wait = Math.max(0, shot.impactAt - now)
          const timer = window.setTimeout(() => {
            impactTimers.current.delete(shot.id)
            dispatch({ type: 'impact', shotId: shot.id, now: Date.now() })
          }, wait)
          impactTimers.current.set(shot.id, timer)
        }
        for (const [id, timer] of impactTimers.current) {
          if (!state.shots.some(shot => shot.id === id)) {
            window.clearTimeout(timer)
            impactTimers.current.delete(id)
          }
        }
      }, [state.shots])

      useEffect(() => () => {
        for (const timer of impactTimers.current.values()) window.clearTimeout(timer)
        impactTimers.current.clear()
        window.clearTimeout(shakeTimer.current)
      }, [])

      useEffect(() => {
        if (state.shakePulse === 0) return NOOP
        setShake(true)
        window.clearTimeout(shakeTimer.current)
        shakeTimer.current = window.setTimeout(() => setShake(false), 160)
        return () => window.clearTimeout(shakeTimer.current)
      }, [state.shakePulse])

      const indexById = useMemo(() => {
        const map = new Map()
        state.bricks.forEach((brick, index) => map.set(brick.id, index))
        return map
      }, [state.bricks])

      const grid = useMemo(
        () => calculateGrid(state.bricks.length, wallSize.width, wallSize.height),
        [state.bricks.length, wallSize.width, wallSize.height],
      )

      useEffect(() => {
        const latest = state.shots[state.shots.length - 1]
        if (latest === undefined) return
        const index = indexById.get(latest.targetId)
        if (index === undefined) return
        const point = pointOf(index, grid)
        if (shotFrame.fieldWidth <= 0 || shotFrame.fieldHeight <= 0) return
        const targetX = shotFrame.wallLeft + (point.x / 100) * shotFrame.wallWidth
        const targetY = shotFrame.wallTop + (point.y / 100) * shotFrame.wallHeight
        const muzzleX = shotFrame.fieldWidth / 2
        const muzzleY = shotFrame.fieldHeight - 30
        setAim(clamp(
          Math.atan2(targetX - muzzleX, muzzleY - targetY) * 180 / Math.PI,
          -72,
          72,
        ))
      }, [state.shots, indexById, grid, shotFrame])

      const alive = aliveCount(state.bricks)
      const total = state.bricks.length
      const destroyedPct = total > 0 ? Math.round((state.destroyed / total) * 100) : 0
      const statusLabel = tr(`status.${state.phase}`)
      const lastTool = state.lastTool.length > 22
        ? `${state.lastTool.slice(0, 21)}…`
        : state.lastTool
      const hint = state.phase === 'paused' && alive > 0
        ? tr('hint.pausedCount', { count: alive })
        : tr(`hint.${state.phase}`)
      const hintWithOverflow = state.overflow > 0
        ? `${hint} · ${tr('hint.trimmed', { count: state.overflow })}`
        : hint

      const onHeaderPointerDown = useCallback((event) => {
        if (event.button !== 0) return
        if (event.target?.closest?.('button')) return
        const rect = cardRef.current?.getBoundingClientRect()
        if (rect === undefined) return
        const origin = position ?? { x: rect.left, y: rect.top }
        setPosition(origin)
        dragRef.current = {
          dx: event.clientX - rect.left,
          dy: event.clientY - rect.top,
        }
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // Pointer capture is an enhancement.
        }
      }, [position])

      const onHeaderPointerMove = useCallback((event) => {
        const drag = dragRef.current
        if (drag === null) return
        const rect = cardRef.current?.getBoundingClientRect()
        if (rect === undefined) return
        const x = clamp(event.clientX - drag.dx, 8, window.innerWidth - rect.width - 8)
        const y = clamp(event.clientY - drag.dy, 8, window.innerHeight - rect.height - 8)
        setPosition({ x, y })
      }, [])

      const onHeaderPointerUp = useCallback((event) => {
        if (dragRef.current === null) return
        dragRef.current = null
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch {
          // The capture may already have been released.
        }
        setPosition((current) => {
          if (current !== null) savePosition(current)
          return current
        })
      }, [])

      const cardStyle = position === null
        ? undefined
        : { left: `${position.x}px`, top: `${position.y}px`, right: 'auto', bottom: 'auto' }
      const aimAngle = clamp(aim, -72, 72)
      const boardStyle = {
        gridTemplateColumns: `repeat(${grid.cols}, ${grid.cellW}px)`,
        gridTemplateRows: `repeat(${grid.rows}, ${grid.cellH}px)`,
        gap: `${grid.gap}px`,
      }
      const muzzlePctY = shotFrame.fieldHeight > 0
        ? ((shotFrame.fieldHeight - 30) / shotFrame.fieldHeight) * 100
        : 100
      const fieldPointOf = (index) => {
        const point = pointOf(index, grid)
        if (
          shotFrame.fieldWidth <= 0
          || shotFrame.fieldHeight <= 0
          || shotFrame.wallWidth <= 0
          || shotFrame.wallHeight <= 0
        ) return point
        return {
          x: ((shotFrame.wallLeft + (point.x / 100) * shotFrame.wallWidth) / shotFrame.fieldWidth) * 100,
          y: ((shotFrame.wallTop + (point.y / 100) * shotFrame.wallHeight) / shotFrame.fieldHeight) * 100,
        }
      }
      const confetti = state.phase === 'celebrate'
        ? Array.from({ length: 26 }, (_, index) => {
          const left = (index * 37 + 11) % 100
          const delay = (index * 53) % 700
          const duration = 1100 + ((index * 97) % 900)
          const drift = ((index * 29) % 120) - 60
          const hue = PALETTE[index % PALETTE.length]
          return h('i', {
            key: `confetti-${index}`,
            className: 'pb-confetti',
            style: {
              left: `${left}%`,
              '--pb-delay': `${delay}ms`,
              '--pb-duration': `${duration}ms`,
              '--pb-drift': `${drift}px`,
              '--pb-hue': hue,
              '--pb-spin': `${(index % 2 === 0 ? 1 : -1) * (240 + index * 11)}deg`,
            },
          })
        })
        : null

      const board = h('div', {
        className: 'pb-playfield',
        ref: playfieldRef,
        role: 'img',
        'aria-label': tr('aria.board'),
      },
      h('div', { className: 'pb-grid-lines', 'aria-hidden': true }),
      h('div', { className: 'pb-wall', ref: wallRef },
        h('div', { className: 'pb-grid', style: boardStyle },
          state.bricks.map(brick => h('div', {
            key: brick.id,
            className: brick.alive ? 'pb-brick' : 'pb-brick is-dead',
            style: {
              '--pb-h': brick.hue,
              borderRadius: `${grid.radius}px`,
            },
            title: brick.alive ? brick.ch : undefined,
          }, brick.alive
            ? h('span', { className: 'pb-char' }, brick.ch)
            : h('span', { className: 'pb-crack', 'aria-hidden': true }))),
        ),
        state.hits.map((hit) => {
          const index = indexById.get(hit.brickId)
          if (index === undefined) return null
          const point = pointOf(index, grid)
          const spread = clamp(grid.cellH * 1.25, 7, 24)
          return h('span', {
            key: hit.id,
            className: 'pb-burst',
            style: {
              left: `${point.x}%`,
              top: `${point.y}%`,
              '--pb-h': hit.hue,
              '--pb-spread': `${spread}px`,
            },
            'aria-hidden': true,
          },
          h('span', { className: 'pb-burst-ring' }),
          Array.from({ length: 7 }, (_, shard) => {
            const angle = (shard / 7) * Math.PI * 2 + (hit.id.length % 5) * 0.27
            const distance = spread * (0.65 + ((shard * 13 + hit.brickId) % 6) / 13)
            return h('span', {
              key: `shard-${shard}`,
              className: 'pb-shard',
              style: {
                '--pb-dx': `${Math.cos(angle) * distance}px`,
                '--pb-dy': `${Math.sin(angle) * distance}px`,
                '--pb-shard-delay': `${shard * 8}ms`,
              },
            })
          }))
        }),
        state.phase === 'idle' && h('div', { className: 'pb-empty' },
          h('strong', null, tr('idle.title')),
          h('span', null, tr('idle.hint'))),
        state.phase === 'paused' && h('div', { className: 'pb-watermark', 'aria-hidden': true }, 'PAUSED'),
      ),
      // Shots live in the playfield, not the wall, so each round is visible
      // leaving the barrel and crossing the open gap below the bricks.
      h('div', { className: 'pb-shot-layer', 'aria-hidden': true },
        h('svg', {
          className: 'pb-tracers',
          viewBox: '0 0 100 100',
          preserveAspectRatio: 'none',
        },
        state.shots.map((shot) => {
          const index = indexById.get(shot.targetId)
          const point = fieldPointOf(index ?? -1)
          return h('line', {
            key: `tracer-${shot.id}`,
            x1: 50,
            y1: muzzlePctY,
            x2: point.x,
            y2: point.y,
            style: {
              animationDelay: `${shot.delay}ms`,
              animationDuration: `${shot.duration}ms`,
            },
          })
        })),
        state.shots.map((shot) => {
          const index = indexById.get(shot.targetId)
          const point = fieldPointOf(index ?? -1)
          return h('span', {
            key: `bullet-${shot.id}`,
            className: 'pb-bullet',
            style: {
              '--pb-sx': '50%',
              '--pb-sy': `${muzzlePctY}%`,
              '--pb-tx': `${point.x}%`,
              '--pb-ty': `${point.y}%`,
              animationDelay: `${shot.delay}ms`,
              animationDuration: `${shot.duration}ms`,
            },
          })
        })),
      h('div', { className: 'pb-cannon', 'aria-hidden': true },
        h('div', {
          className: 'pb-barrel',
          style: { transform: `rotate(${aimAngle}deg)` },
        }),
        h('div', { className: 'pb-turret' }),
        h('div', { className: 'pb-base' })),
      state.firePulse > 0 && h('div', {
        key: `muzzle-${state.firePulse}`,
        className: 'pb-muzzle',
        'aria-hidden': true,
      }),
      state.phase === 'celebrate' && h('div', { className: 'pb-celebration' },
        h('div', { className: 'pb-celebration-glow', 'aria-hidden': true }),
        h('div', { className: 'pb-confetti-layer', 'aria-hidden': true }, confetti),
        h('div', { className: 'pb-clear-copy' },
          h('span', { className: 'pb-clear-kicker' }, tr('clear.kicker')),
          h('strong', { className: 'pb-clear-title' }, tr('clear.title')),
          h('span', { className: 'pb-clear-hint' }, tr('clear.hint')))))

      return ReactDOM.createPortal(
        h('div', { className: 'pb-layer' },
          h('section', {
            ref: cardRef,
            className: `pb-card${shake ? ' is-shaking' : ''}${minimized ? ' is-minimized' : ''}`,
            style: cardStyle,
            role: 'region',
            'aria-label': tr('aria.region'),
          },
          h('header', {
            className: 'pb-header',
            onPointerDown: onHeaderPointerDown,
            onPointerMove: onHeaderPointerMove,
            onPointerUp: onHeaderPointerUp,
            onPointerCancel: onHeaderPointerUp,
          },
          h('span', { className: 'pb-logo', 'aria-hidden': true },
            h('i', null), h('i', null), h('i', null)),
          h('div', { className: 'pb-heading' },
            h('strong', { className: 'pb-title' }, tr('title')),
            h('span', { className: 'pb-subtitle' }, lastTool || tr('subtitle'))),
          h('span', {
            className: `pb-status is-${state.phase}`,
            'aria-label': tr('aria.status', { status: statusLabel }),
          },
          h('i', { className: 'pb-status-dot', 'aria-hidden': true }),
          statusLabel),
          h('button', {
            type: 'button',
            className: 'pb-minimize',
            title: minimized ? tr('aria.expand') : tr('aria.minimize'),
            'aria-label': minimized ? tr('aria.expand') : tr('aria.minimize'),
            'aria-expanded': !minimized,
            onPointerDown: event => event.stopPropagation(),
            onClick: toggleMinimized,
          }, minimized ? '▢' : '—')),
          !minimized && board,
          !minimized && h('footer', { className: 'pb-footer' },
            h('div', { className: 'pb-progress', 'aria-hidden': true },
              h('span', { style: { width: `${destroyedPct}%` } })),
            h('div', { className: 'pb-stats' },
              h('span', null, h('b', null, pad3(state.shotsFired)), tr('stat.shots')),
              h('span', null, h('b', null, pad3(state.destroyed)), tr('stat.hits')),
              h('span', null, h('b', null, pad3(alive)), tr('stat.left'))),
            h('p', { className: 'pb-hint', 'aria-live': 'polite' }, hintWithOverflow))),
        h('style', null, CSS)),
        document.body,
      )
    }

    const CSS = `
      .pb-layer {
        position: fixed;
        inset: 0;
        z-index: 2147483000;
        pointer-events: none;
      }
      .pb-card {
        position: fixed;
        right: 18px;
        bottom: 104px;
        width: min(460px, calc(100vw - 20px));
        overflow: hidden;
        border: 1px solid var(--dsw-alias-border-l1, rgba(148, 163, 184, .45));
        border-radius: 16px;
        background: var(--dsw-alias-bg-overlay, #10131c);
        color: var(--dsw-alias-label-primary, #f4f7ff);
        box-shadow:
          0 22px 70px rgba(0, 0, 0, .42),
          0 0 0 1px rgba(255, 255, 255, .04) inset,
          0 1px 0 rgba(255, 255, 255, .08) inset;
        pointer-events: auto;
        font-family: inherit;
        backdrop-filter: blur(18px) saturate(1.15);
      }
      .pb-card.is-minimized {
        width: min(318px, calc(100vw - 20px));
      }
      .pb-card.is-shaking {
        animation: pb-shake .16s linear;
      }
      .pb-header {
        display: flex;
        align-items: center;
        gap: 9px;
        min-height: 46px;
        padding: 8px 10px 8px 12px;
        border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(148, 163, 184, .22));
        cursor: grab;
        touch-action: none;
        user-select: none;
      }
      .pb-header:active {
        cursor: grabbing;
      }
      .pb-logo {
        display: grid;
        flex: none;
        grid-template-columns: repeat(2, 7px);
        grid-template-rows: repeat(2, 5px);
        gap: 2px;
        width: 24px;
        height: 22px;
        align-content: center;
        justify-content: center;
        border-radius: 7px;
        background: linear-gradient(145deg, rgba(71, 101, 255, .32), rgba(0, 0, 0, .14));
        box-shadow: 0 0 0 1px rgba(123, 151, 255, .35) inset;
      }
      .pb-logo i {
        display: block;
        border-radius: 1.5px;
        background: linear-gradient(160deg, #71f7d6, #10aa9c);
        box-shadow: 0 0 5px rgba(91, 255, 221, .55);
      }
      .pb-logo i:nth-child(2) {
        background: linear-gradient(160deg, #ff9fdf, #c9379a);
        box-shadow: 0 0 5px rgba(255, 122, 211, .55);
      }
      .pb-logo i:nth-child(3) {
        background: linear-gradient(160deg, #ffe486, #e49a1c);
        box-shadow: 0 0 5px rgba(255, 211, 92, .5);
      }
      .pb-heading {
        display: flex;
        flex: 1;
        min-width: 0;
        flex-direction: column;
        gap: 1px;
      }
      .pb-title {
        overflow: hidden;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: .015em;
        line-height: 1.25;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .pb-subtitle {
        overflow: hidden;
        color: var(--dsw-alias-label-secondary, #94a3b8);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 9px;
        letter-spacing: .085em;
        line-height: 1.2;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .pb-status {
        display: inline-flex;
        flex: none;
        align-items: center;
        gap: 5px;
        padding: 4px 7px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(148, 163, 184, .3));
        border-radius: 999px;
        background: var(--dsw-alias-bg-layer-2, rgba(148, 163, 184, .08));
        color: var(--dsw-alias-label-secondary, #a6b2c8);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 8px;
        font-weight: 700;
        letter-spacing: .1em;
        line-height: 1;
      }
      .pb-status-dot {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: var(--dsw-alias-state-idle-primary, #8793a9);
      }
      .pb-status.is-running {
        border-color: rgba(64, 255, 202, .28);
        color: var(--dsw-alias-state-success-primary, #80ffee);
      }
      .pb-status.is-running .pb-status-dot {
        background: #4dffcd;
        box-shadow: 0 0 8px rgba(77, 255, 205, .9);
        animation: pb-live 1.2s ease-in-out infinite;
      }
      .pb-status.is-paused {
        border-color: rgba(255, 196, 92, .26);
        color: var(--dsw-alias-state-warn-primary, #ffd489);
      }
      .pb-status.is-paused .pb-status-dot {
        background: #ffc45c;
      }
      .pb-status.is-celebrate {
        border-color: rgba(255, 221, 104, .32);
        color: var(--dsw-alias-state-warn-primary, #ffe27c);
      }
      .pb-status.is-celebrate .pb-status-dot {
        background: #ffe27c;
        box-shadow: 0 0 9px rgba(255, 226, 124, .9);
      }
      .pb-minimize {
        display: grid;
        flex: none;
        width: 24px;
        height: 24px;
        place-items: center;
        padding: 0;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: var(--dsw-alias-label-secondary, #a6b2c8);
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        line-height: 1;
      }
      .pb-minimize:hover {
        background: var(--dsw-alias-bg-layer-2, rgba(148, 163, 184, .13));
        color: var(--dsw-alias-label-primary, #f4f7ff);
      }
      .pb-minimize:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #6d8dff);
        outline-offset: 1px;
      }
      .pb-playfield {
        position: relative;
        height: clamp(188px, 28vh, 238px);
        overflow: hidden;
        padding: 8px 9px 4px;
        border-top: 1px solid rgba(130, 164, 255, .12);
        border-bottom: 1px solid rgba(0, 0, 0, .4);
        background:
          radial-gradient(ellipse at 50% -12%, rgba(81, 126, 255, .2), transparent 58%),
          linear-gradient(180deg, #070a14 0%, #0a1020 55%, #050810 100%);
        isolation: isolate;
      }
      .pb-playfield::after {
        position: absolute;
        inset: 0;
        z-index: 9;
        pointer-events: none;
        content: '';
        background: repeating-linear-gradient(0deg, rgba(255, 255, 255, .018) 0 1px, transparent 1px 3px);
        mix-blend-mode: screen;
      }
      .pb-grid-lines {
        position: absolute;
        inset: 0;
        opacity: .45;
        background-image:
          linear-gradient(rgba(120, 153, 255, .05) 1px, transparent 1px),
          linear-gradient(90deg, rgba(120, 153, 255, .05) 1px, transparent 1px);
        background-size: 28px 28px;
        mask-image: radial-gradient(ellipse at center, black, transparent 82%);
      }
      .pb-wall {
        position: relative;
        z-index: 2;
        display: flex;
        width: 100%;
        height: calc(100% - 48px);
        align-items: center;
        justify-content: center;
      }
      .pb-grid {
        display: grid;
        align-content: center;
        justify-content: center;
      }
      .pb-brick {
        position: relative;
        display: flex;
        min-width: 0;
        min-height: 0;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        border-top: 1px solid hsl(var(--pb-h) 100% 80% / .7);
        border-bottom: 1px solid hsl(var(--pb-h) 80% 28% / .7);
        background:
          linear-gradient(155deg, hsl(var(--pb-h) 96% 68%), hsl(var(--pb-h) 88% 43%));
        box-shadow:
          0 0 9px hsl(var(--pb-h) 92% 56% / .24),
          0 2px 4px rgba(0, 0, 0, .28);
        color: #fff;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-weight: 800;
        line-height: 1;
        text-shadow:
          0 1px 1px rgba(0, 0, 0, .45),
          0 0 7px hsl(var(--pb-h) 100% 78% / .5);
      }
      .pb-brick::before {
        position: absolute;
        inset: 1px 1px auto;
        height: 35%;
        border-radius: inherit;
        content: '';
        background: linear-gradient(180deg, rgba(255, 255, 255, .26), transparent);
        opacity: .75;
        pointer-events: none;
      }
      .pb-char {
        position: relative;
        z-index: 1;
        transform: translateY(.02em);
      }
      .pb-brick.is-dead {
        border-color: rgba(129, 151, 192, .08);
        background:
          radial-gradient(circle at 50% 45%, rgba(0, 0, 0, .3), transparent 70%),
          rgba(255, 255, 255, .022);
        box-shadow: inset 0 0 0 1px rgba(129, 151, 192, .07);
      }
      .pb-crack {
        width: 28%;
        height: 28%;
        border-radius: 50%;
        background: rgba(0, 0, 0, .34);
        box-shadow:
          4px -3px 0 -2px rgba(0, 0, 0, .25),
          -3px 4px 0 -2px rgba(0, 0, 0, .2);
      }
      .pb-shot-layer {
        position: absolute;
        inset: 0;
        z-index: 7;
        overflow: hidden;
        pointer-events: none;
      }
      .pb-tracers {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        overflow: visible;
        pointer-events: none;
      }
      .pb-tracers line {
        stroke: rgba(255, 239, 160, .62);
        stroke-width: 1.1;
        stroke-linecap: round;
        stroke-dasharray: 3 5;
        vector-effect: non-scaling-stroke;
        animation-name: pb-trace;
        animation-timing-function: cubic-bezier(.2, .7, .4, 1);
        animation-fill-mode: both;
      }
      .pb-bullet {
        position: absolute;
        z-index: 2;
        left: var(--pb-sx, 50%);
        top: var(--pb-sy, 100%);
        width: 6px;
        height: 6px;
        margin: -3px 0 0 -3px;
        border-radius: 50%;
        background: #fff5b8;
        box-shadow:
          0 0 5px 2px rgba(255, 225, 105, .75),
          0 0 14px 4px rgba(255, 184, 56, .32);
        pointer-events: none;
        animation-name: pb-shot;
        animation-timing-function: cubic-bezier(.18, .82, .35, 1);
        animation-fill-mode: both;
      }
      .pb-burst {
        position: absolute;
        z-index: 5;
        width: 0;
        height: 0;
        pointer-events: none;
      }
      .pb-burst-ring {
        position: absolute;
        left: -9px;
        top: -9px;
        width: 18px;
        height: 18px;
        border: 1.5px solid hsl(var(--pb-h) 100% 80% / .9);
        border-radius: 50%;
        box-shadow: 0 0 12px hsl(var(--pb-h) 100% 66% / .7);
        animation: pb-ring .5s ease-out forwards;
      }
      .pb-shard {
        position: absolute;
        left: -1.5px;
        top: -1.5px;
        width: 3px;
        height: 3px;
        border-radius: 1px;
        background: hsl(var(--pb-h) 100% 72%);
        box-shadow: 0 0 5px hsl(var(--pb-h) 100% 64% / .7);
        animation: pb-shard .52s cubic-bezier(.16, .7, .3, 1) forwards;
        animation-delay: var(--pb-shard-delay);
      }
      .pb-empty {
        position: absolute;
        inset: 0;
        z-index: 6;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 5px;
        color: rgba(162, 181, 220, .58);
        text-align: center;
        pointer-events: none;
      }
      .pb-empty strong {
        color: rgba(147, 231, 255, .7);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 22px;
        letter-spacing: .24em;
        text-shadow: 0 0 22px rgba(80, 189, 255, .45);
      }
      .pb-empty span {
        font-size: 11px;
        letter-spacing: .03em;
      }
      .pb-watermark {
        position: absolute;
        right: 12px;
        bottom: 14px;
        color: rgba(255, 205, 110, .12);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 26px;
        font-weight: 800;
        letter-spacing: .18em;
        pointer-events: none;
        user-select: none;
      }
      .pb-celebration {
        position: absolute;
        inset: 0;
        z-index: 10;
        overflow: hidden;
        pointer-events: none;
      }
      .pb-celebration-glow {
        position: absolute;
        inset: -40%;
        background:
          radial-gradient(circle at 50% 47%, rgba(255, 226, 109, .28), transparent 28%),
          radial-gradient(circle at 50% 50%, rgba(74, 255, 213, .13), transparent 44%);
        animation: pb-clear-glow 1.6s ease-out both;
      }
      .pb-confetti-layer {
        position: absolute;
        inset: 0;
      }
      .pb-confetti {
        position: absolute;
        top: -12px;
        width: 5px;
        height: 8px;
        border-radius: 1px;
        background: hsl(var(--pb-hue) 95% 65%);
        box-shadow: 0 0 6px hsl(var(--pb-hue) 95% 60% / .65);
        animation: pb-confetti var(--pb-duration) linear var(--pb-delay) 2 both;
      }
      .pb-clear-copy {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 3px;
        text-align: center;
        text-shadow: 0 2px 16px rgba(0, 0, 0, .7);
        animation: pb-clear-copy .55s cubic-bezier(.16, 1.2, .35, 1) both;
      }
      .pb-clear-kicker {
        color: #ffe27c;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 8px;
        font-weight: 700;
        letter-spacing: .22em;
      }
      .pb-clear-title {
        color: #fff3b0;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: clamp(26px, 8vw, 40px);
        font-weight: 900;
        letter-spacing: .08em;
        line-height: 1.05;
        text-shadow:
          0 0 12px rgba(255, 217, 82, .9),
          0 0 38px rgba(255, 189, 48, .55);
      }
      .pb-clear-hint {
        color: rgba(231, 240, 255, .72);
        font-size: 10px;
        letter-spacing: .02em;
      }
      .pb-cannon {
        position: absolute;
        z-index: 6;
        left: 50%;
        bottom: 1px;
        width: 58px;
        height: 28px;
        transform: translateX(-50%);
        pointer-events: none;
      }
      .pb-barrel {
        position: absolute;
        left: 50%;
        bottom: 12px;
        width: 8px;
        height: 17px;
        margin-left: -4px;
        border-radius: 4px 4px 2px 2px;
        background: linear-gradient(90deg, #233254, #7cc8c6 48%, #233254);
        box-shadow: 0 0 9px rgba(94, 247, 229, .36);
        transform-origin: 50% 100%;
        transition: transform .12s ease-out;
      }
      .pb-turret {
        position: absolute;
        left: 50%;
        bottom: 7px;
        width: 24px;
        height: 13px;
        margin-left: -12px;
        border: 1px solid rgba(124, 225, 218, .36);
        border-radius: 9px 9px 4px 4px;
        background: linear-gradient(180deg, #30466f, #15213a);
        box-shadow: 0 0 12px rgba(83, 228, 213, .16);
      }
      .pb-turret::after {
        position: absolute;
        left: 50%;
        top: 3px;
        width: 5px;
        height: 5px;
        margin-left: -2.5px;
        border-radius: 50%;
        content: '';
        background: #7dfff0;
        box-shadow: 0 0 8px rgba(125, 255, 240, .9);
      }
      .pb-base {
        position: absolute;
        left: 50%;
        bottom: 0;
        width: 42px;
        height: 7px;
        margin-left: -21px;
        border: 1px solid rgba(124, 225, 218, .22);
        border-radius: 4px 4px 7px 7px;
        background: linear-gradient(180deg, #233657, #0b1323);
      }
      .pb-muzzle {
        position: absolute;
        z-index: 7;
        left: 50%;
        bottom: 23px;
        width: 16px;
        height: 16px;
        margin-left: -8px;
        border-radius: 50%;
        background: radial-gradient(circle, #fffde0 0 22%, #ffd35e 35%, transparent 70%);
        animation: pb-muzzle .2s ease-out forwards;
        pointer-events: none;
      }
      .pb-footer {
        position: relative;
        padding: 8px 12px 9px;
        background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, .025));
      }
      .pb-progress {
        position: absolute;
        inset: 0 0 auto;
        height: 2px;
        overflow: hidden;
        background: rgba(255, 255, 255, .05);
      }
      .pb-progress span {
        display: block;
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(90deg, #52f5d5, #ffd55f 70%, #ff79c8);
        box-shadow: 0 0 10px rgba(255, 209, 94, .45);
        transition: width .28s ease-out;
      }
      .pb-stats {
        display: flex;
        gap: 14px;
        color: var(--dsw-alias-label-secondary, #94a3b8);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 9px;
        letter-spacing: .08em;
        line-height: 1.2;
      }
      .pb-stats b {
        margin-right: 4px;
        color: var(--dsw-alias-label-primary, #eef4ff);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: .02em;
      }
      .pb-hint {
        margin: 4px 0 0;
        overflow: hidden;
        color: var(--dsw-alias-label-secondary, #94a3b8);
        font-size: 9.5px;
        line-height: 1.35;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      @keyframes pb-shot {
        0% {
          left: var(--pb-sx, 50%);
          top: var(--pb-sy, 100%);
          opacity: 0;
          transform: scale(.45);
        }
        12% {
          opacity: 1;
        }
        100% {
          left: var(--pb-tx);
          top: var(--pb-ty);
          opacity: 1;
          transform: scale(1);
        }
      }
      @keyframes pb-trace {
        0% {
          opacity: 0;
          stroke-dashoffset: 42;
        }
        18% {
          opacity: .9;
        }
        100% {
          opacity: 0;
          stroke-dashoffset: 0;
        }
      }
      @keyframes pb-ring {
        0% {
          opacity: 1;
          transform: scale(.3);
        }
        100% {
          opacity: 0;
          transform: scale(2.35);
        }
      }
      @keyframes pb-shard {
        0% {
          opacity: 1;
          transform: translate(0, 0) rotate(0);
        }
        100% {
          opacity: 0;
          transform: translate(var(--pb-dx), var(--pb-dy)) rotate(160deg);
        }
      }
      @keyframes pb-muzzle {
        0% {
          opacity: 1;
          transform: scale(.4);
        }
        100% {
          opacity: 0;
          transform: scale(1.8);
        }
      }
      @keyframes pb-shake {
        0%, 100% { transform: translate3d(0, 0, 0); }
        20% { transform: translate3d(-2px, 1px, 0); }
        40% { transform: translate3d(2px, -1px, 0); }
        60% { transform: translate3d(-1px, -1px, 0); }
        80% { transform: translate3d(1px, 1px, 0); }
      }
      @keyframes pb-live {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: .45; transform: scale(.72); }
      }
      @keyframes pb-confetti {
        0% {
          opacity: 0;
          transform: translate3d(0, -12px, 0) rotate(0);
        }
        10% {
          opacity: 1;
        }
        100% {
          opacity: 0;
          transform: translate3d(var(--pb-drift), 245px, 0) rotate(var(--pb-spin));
        }
      }
      @keyframes pb-clear-glow {
        0% { opacity: 0; transform: scale(.7); }
        28% { opacity: 1; }
        100% { opacity: .55; transform: scale(1); }
      }
      @keyframes pb-clear-copy {
        0% { opacity: 0; transform: scale(.72); }
        100% { opacity: 1; transform: scale(1); }
      }
      @media (max-width: 560px) {
        .pb-card {
          right: 10px;
          bottom: 88px;
          width: calc(100vw - 20px);
        }
        .pb-playfield {
          height: clamp(170px, 26vh, 210px);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .pb-card.is-shaking {
          animation: none;
        }
        .pb-confetti {
          display: none;
        }
        .pb-status.is-running .pb-status-dot {
          animation: none;
        }
      }
    `

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'prompt-breaker: copy')
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'prompt-breaker',
          order: 900,
          locale: NS,
          inject: (sessionId) => {
            const sessions = ctx.sessions
            return { binding: sessions.binding(sessionId) }
          },
        }, PromptBreaker))
      },
    }
  },
})
