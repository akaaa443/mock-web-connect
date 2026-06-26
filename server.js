/**
 * Mock WebSocket server for AIS Web Connect ID card reader
 *
 * Serves:
 *   wss://localhost:8088/ReadIDCard  — WebSocket endpoint for the Angular app
 *   https://localhost:8088/          — Control UI to edit profile and trigger events
 *
 * Usage:
 *   npm run gen-cert   # generate self-signed cert (first time only)
 *   npm start
 */

const https = require('https')
const fs = require('fs')
const path = require('path')
const { WebSocketServer } = require('ws')
const cardReader = require('./card-reader')

const PORT = 8088
const CERT_DIR = path.join(__dirname, 'certs')

// Card reader state (polled by UI via /api/reader-status)
const readerState = { status: 'idle', readerName: null, lastError: null }

// ---------------------------------------------------------------------------
// Mock profile
// ---------------------------------------------------------------------------
let currentProfile = {
  NationalID: '1100100000001',
  ThaiTitleName: 'นาย',
  EnglishTitleName: 'MR.',
  ThaiFirstName: 'ทดสอบ',
  ThaiLastName: 'ระบบ',
  EnglishFirstName: 'THADSOB',
  EnglishLastName: 'RABOB',
  Birthdate: '19900115',
  Sex: '1',
  Address: '123',
  Moo: 'หมู่ที่5',
  Soi: 'ซอยทดสอบ',
  Thanon: 'ถนนพหลโยธิน',
  Tumbol: 'ตำบลลาดยาว',
  Amphur: 'อำเภอจตุจักร',
  Province: 'จังหวัดกรุงเทพมหานคร',
  IssueDate: '20200101',
  ExpireDate: '20300101',
  ChipID: '0000000000001',
  RequestNo: 'REQ0000001',
  LaserID: 'ME1234567890'
}

const MOCK_PHOTO =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const eventLog = []
function logEvent (direction, payload) {
  eventLog.unshift({ time: new Date().toISOString(), direction, payload })
  if (eventLog.length > 100) eventLog.pop()
  console.log(`${direction === 'out' ? '→' : '←'} ${JSON.stringify(payload)}`)
}

// ---------------------------------------------------------------------------
// SSL
// ---------------------------------------------------------------------------
function loadCerts () {
  const keyPath  = path.join(CERT_DIR, 'key.pem')
  const certPath = path.join(CERT_DIR, 'cert.pem')
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.error('Certificates not found. Run: npm run gen-cert')
    process.exit(1)
  }
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------
const connectedClients = new Set()

function broadcast (payload) {
  const msg = JSON.stringify(payload)
  connectedClients.forEach(ws => {
    if (ws.readyState === ws.OPEN) { ws.send(msg); logEvent('out', payload) }
  })
}

function triggerSuccess () {
  const profileBase64 = Buffer.from(JSON.stringify(currentProfile), 'utf8').toString('base64')
  broadcast({ Event: 'OnCardInserted' })
  ;[20, 40, 60, 80, 100].forEach((p, i) =>
    setTimeout(() => broadcast({ Event: 'OnCardLoadProgress', Progress: p }), (i + 1) * 500)
  )
  setTimeout(() =>
    broadcast({ Event: 'OnCardLoadCompleted', Data: profileBase64, PhotoImage: MOCK_PHOTO }), 3500
  )
}

function triggerFailed (message) {
  broadcast({ Event: 'OnCardInserted' })
  setTimeout(() =>
    broadcast({ Event: 'OnCardLoadError', Message: message || 'ไม่สามารถอ่านบัตรประชาชนได้' }), 800
  )
}

// ---------------------------------------------------------------------------
// Physical card reader events
// ---------------------------------------------------------------------------
cardReader.on('reader-connected', (name) => {
  readerState.status = 'waiting'
  readerState.readerName = name
  readerState.lastError = null
  console.log(`[card-reader] Reader ready: ${name}`)
})

cardReader.on('reader-disconnected', () => {
  readerState.status = 'idle'
  readerState.readerName = null
})

cardReader.on('card-inserted', () => {
  readerState.status = 'reading'
  readerState.lastError = null
})

cardReader.on('card-removed', () => {
  if (readerState.status !== 'done') readerState.status = 'waiting'
})

cardReader.on('card-data', (profile) => {
  currentProfile = profile
  readerState.status = 'done'
  console.log('[card-reader] Profile captured:', profile.NationalID)
})

cardReader.on('error', (msg) => {
  readerState.lastError = msg
  readerState.status = readerState.readerName ? 'waiting' : 'idle'
  console.error('[card-reader]', msg)
})

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------
function handleRequest (req, res) {
  const url = new URL(req.url, `https://localhost:${PORT}`)

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  const json = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }

  if (req.method === 'GET' && url.pathname === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(html)
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return json({ clients: connectedClients.size, log: eventLog.slice(0, 20) })
  }
  if (req.method === 'GET' && url.pathname === '/api/profile') {
    return json(currentProfile)
  }
  if (req.method === 'GET' && url.pathname === '/api/reader-status') {
    return json(readerState)
  }

  if (req.method === 'POST') {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {}
        if (url.pathname === '/api/profile') {
          currentProfile = { ...currentProfile, ...data }
          return json({ success: true })
        }
        if (url.pathname === '/api/reader/start') {
          readerState.status = 'idle'
          readerState.lastError = null
          cardReader.start()
          return json({ success: true })
        }
        if (url.pathname === '/api/trigger/insert')  { broadcast({ Event: 'OnCardInserted' }); return json({ success: true }) }
        if (url.pathname === '/api/trigger/success') { triggerSuccess(); return json({ success: true }) }
        if (url.pathname === '/api/trigger/failed')  { triggerFailed(data.message); return json({ success: true }) }
        if (url.pathname === '/api/trigger/remove')  { broadcast({ Event: 'OnCardRemoved' }); return json({ success: true }) }
        res.writeHead(404); res.end('Not found')
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })) }
    })
    return
  }

  res.writeHead(404); res.end('Not found')
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
const server = https.createServer(loadCerts(), handleRequest)
const wss = new WebSocketServer({ server, path: '/ReadIDCard' })
let clientCount = 0

wss.on('connection', (ws, req) => {
  const id = `client-${++clientCount}`
  connectedClients.add(ws)
  console.log(`[${id}] connected`)
  ws.send(JSON.stringify({ Event: 'OnInitialized' }))
  logEvent('out', { Event: 'OnInitialized' })
  ws.on('message', msg => logEvent('in', JSON.parse(msg)))
  ws.on('close', () => { connectedClients.delete(ws); console.log(`[${id}] disconnected`) })
  ws.on('error', err => console.error(`[${id}] ${err.message}`))
})

// Auto-start card reader listener
cardReader.start()

server.listen(PORT, () => {
  console.log(`Mock WebSocket server  wss://localhost:${PORT}/ReadIDCard`)
  console.log(`Control UI             https://localhost:${PORT}/`)
  console.log('Waiting for connections...\n')
})
