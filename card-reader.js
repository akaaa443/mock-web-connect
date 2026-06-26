/**
 * Thai National ID Card reader via PC/SC (pcsclite)
 *
 * Reads all fields from a Thai ID card inserted into a physical reader.
 * Emits events: 'reader-connected', 'reader-disconnected', 'card-inserted',
 *               'card-removed', 'card-data', 'error'
 */

const { EventEmitter } = require('events')

// Thai ID card APDU commands
const APDU = {
  SELECT_MF:  Buffer.from([0x00, 0xA4, 0x00, 0x00]),
  SELECT_THAI_ID: Buffer.from([0x00, 0xA4, 0x04, 0x00, 0x08, 0xA0, 0x00, 0x00, 0x00, 0x54, 0x48, 0x00, 0x01]),
  SELECT_PERSONAL:  Buffer.from([0x00, 0xA4, 0x01, 0x00, 0x02, 0x00, 0x11]),
  SELECT_CARD_ID:   Buffer.from([0x00, 0xA4, 0x02, 0x04, 0x02, 0xB0, 0x00]),
  SELECT_PERSONAL2: Buffer.from([0x00, 0xA4, 0x02, 0x04, 0x02, 0xB0, 0x02]),
  SELECT_ADDRESS:   Buffer.from([0x00, 0xA4, 0x02, 0x04, 0x02, 0xB0, 0x06]),
  SELECT_PHOTO:     Buffer.from([0x00, 0xA4, 0x02, 0x04, 0x02, 0xB0, 0x01]),
  read: (offset, length) => Buffer.from([0x00, 0xB0, (offset >> 8) & 0xFF, offset & 0xFF, length]),
}

function decodeTIS620 (buf) {
  const arr = Array.from(buf)
  return arr.map(b => {
    if (b === 0x00 || b === 0xFF) return ''
    if (b < 0x80) return String.fromCharCode(b)
    if (b >= 0xA1 && b <= 0xFB) return String.fromCharCode(b - 0xA1 + 0x0E01)
    return ''
  }).join('').trim()
}

function decodeASCII (buf) {
  return buf.toString('ascii').replace(/\x00/g, '').trim()
}

function isSuccess (resp) {
  const len = resp.length
  return len >= 2 && resp[len - 2] === 0x90 && resp[len - 1] === 0x00
}

function responseData (resp) {
  return resp.slice(0, resp.length - 2)
}

async function transmit (card, apdu) {
  return new Promise((resolve, reject) => {
    card.transmit(apdu, 0x100, card.activeProtocol, (err, data) => {
      if (err) return reject(err)
      resolve(data)
    })
  })
}

async function readBinary (card, length) {
  const chunks = []
  let offset = 0
  while (offset < length) {
    const chunk = Math.min(0xFE, length - offset)
    const resp = await transmit(card, APDU.read(offset, chunk))
    if (!isSuccess(resp)) throw new Error(`Read failed at offset ${offset}: ${resp.toString('hex')}`)
    chunks.push(responseData(resp))
    offset += chunk
  }
  return Buffer.concat(chunks)
}

async function readThaiIDCard (card) {
  // Select Thai ID card application
  let resp = await transmit(card, APDU.SELECT_THAI_ID)
  if (!isSuccess(resp)) throw new Error('Failed to select Thai ID application')

  // --- Citizen ID ---
  resp = await transmit(card, APDU.SELECT_CARD_ID)
  if (!isSuccess(resp)) throw new Error('Failed to select card ID file')
  const cidBuf = await readBinary(card, 20)
  const NationalID = decodeASCII(cidBuf).replace(/\D/g, '').slice(0, 13)

  // --- Personal info (TH + EN names, birthdate, gender, laser code) ---
  resp = await transmit(card, APDU.SELECT_PERSONAL2)
  if (!isSuccess(resp)) throw new Error('Failed to select personal file')
  const personalBuf = await readBinary(card, 200)

  // Layout: [TH prefix 100 bytes][TH firstname 100 bytes][TH lastname 100 bytes]
  //         [EN prefix 100][EN firstname 100][EN lastname 100]
  //         [birthdate 8 ascii][gender 1][issue 8][expire 8][laser 12]
  let off = 0
  const ThaiTitleName   = decodeTIS620(personalBuf.slice(off, off + 100)); off += 100
  const ThaiFirstName   = decodeTIS620(personalBuf.slice(off, off + 100)); off += 100
  const ThaiLastName    = decodeTIS620(personalBuf.slice(off, off + 100)); off += 100

  // read another block for EN names and dates
  const personal2Buf = await readBinary(card, 600)
  let off2 = 0
  const EnglishTitleName = decodeASCII(personal2Buf.slice(off2, off2 + 80)); off2 += 80
  const EnglishFirstName = decodeASCII(personal2Buf.slice(off2, off2 + 150)); off2 += 150
  const EnglishLastName  = decodeASCII(personal2Buf.slice(off2, off2 + 150)); off2 += 150
  const birthdateRaw     = decodeASCII(personal2Buf.slice(off2, off2 + 8));  off2 += 8
  const Sex              = decodeASCII(personal2Buf.slice(off2, off2 + 1));  off2 += 1
  off2 += 20 // issuer + issue date placeholder
  const issueDateRaw     = decodeASCII(personal2Buf.slice(off2, off2 + 8));  off2 += 8
  const expireDateRaw    = decodeASCII(personal2Buf.slice(off2, off2 + 8));  off2 += 8
  const LaserID          = decodeASCII(personal2Buf.slice(off2, off2 + 14));

  // Convert yyyymmdd → yyyymmdd (already correct format for our mock)
  const Birthdate   = birthdateRaw.replace(/\D/g, '').slice(0, 8) || '00000000'
  const IssueDate   = issueDateRaw.replace(/\D/g, '').slice(0, 8)  || '00000000'
  const ExpireDate  = expireDateRaw.replace(/\D/g, '').slice(0, 8) || '99999999'

  // --- Address ---
  resp = await transmit(card, APDU.SELECT_ADDRESS)
  if (!isSuccess(resp)) throw new Error('Failed to select address file')
  const addrBuf = await readBinary(card, 300)
  let offA = 0
  const Address  = decodeTIS620(addrBuf.slice(offA, offA + 40));  offA += 40
  const Moo      = decodeTIS620(addrBuf.slice(offA, offA + 40));  offA += 40
  const Soi      = decodeTIS620(addrBuf.slice(offA, offA + 40));  offA += 40
  const Thanon   = decodeTIS620(addrBuf.slice(offA, offA + 40));  offA += 40
  const Tumbol   = decodeTIS620(addrBuf.slice(offA, offA + 40));  offA += 40
  const Amphur   = decodeTIS620(addrBuf.slice(offA, offA + 40));  offA += 40
  const Province = decodeTIS620(addrBuf.slice(offA, offA + 40));

  return {
    NationalID,
    ThaiTitleName,
    EnglishTitleName,
    ThaiFirstName,
    ThaiLastName,
    EnglishFirstName,
    EnglishLastName,
    Birthdate,
    Sex: Sex === '1' || Sex === '1' ? '1' : '2',
    Address,
    Moo,
    Soi,
    Thanon,
    Tumbol,
    Amphur,
    Province,
    IssueDate,
    ExpireDate,
    ChipID: '0000000000001',
    RequestNo: '',
    LaserID: LaserID || ''
  }
}

// ---------------------------------------------------------------------------
// CardReaderService — EventEmitter
// ---------------------------------------------------------------------------
class CardReaderService extends EventEmitter {
  constructor () {
    super()
    this._pcsc = null
    this._readerName = null
    this._started = false
  }

  start () {
    if (this._started) return
    this._started = true
    let pcsc
    try {
      pcsc = require('@pokusew/pcsclite')()
      this._pcsc = pcsc
    } catch (e) {
      this.emit('error', 'PC/SC is not available on this system: ' + e.message)
      return
    }

    pcsc.on('reader', (reader) => {
      this._readerName = reader.name
      console.log(`[card-reader] Reader connected: ${reader.name}`)
      this.emit('reader-connected', reader.name)

      reader.on('status', async (status) => {
        const changes = reader.state ^ status.state
        if (!changes) return

        if (changes & reader.SCARD_STATE_PRESENT && status.state & reader.SCARD_STATE_PRESENT) {
          this.emit('card-inserted')
          reader.connect({ share_mode: reader.SCARD_SHARE_SHARED }, async (err, protocol) => {
            if (err) {
              this.emit('error', 'Failed to connect to card: ' + err.message)
              return
            }
            const card = { transmit: reader.transmit.bind(reader), activeProtocol: protocol }
            try {
              console.log('[card-reader] Reading card...')
              const profile = await readThaiIDCard(card)
              console.log('[card-reader] Card read successfully')
              this.emit('card-data', profile)
            } catch (e) {
              console.error('[card-reader] Read error:', e.message)
              this.emit('error', 'Card read failed: ' + e.message)
            }
            reader.disconnect(reader.SCARD_LEAVE_CARD, (err) => {
              if (err) console.error('[card-reader] disconnect error:', err)
            })
          })
        }

        if (changes & reader.SCARD_STATE_EMPTY && status.state & reader.SCARD_STATE_EMPTY) {
          this.emit('card-removed')
        }
      })

      reader.on('end', () => {
        this._readerName = null
        console.log(`[card-reader] Reader disconnected: ${reader.name}`)
        this.emit('reader-disconnected', reader.name)
      })

      reader.on('error', (err) => {
        this.emit('error', 'Reader error: ' + err.message)
      })
    })

    pcsc.on('error', (err) => {
      this.emit('error', 'PC/SC error: ' + err.message)
    })
  }

  stop () {
    if (this._pcsc) {
      this._pcsc.close()
      this._pcsc = null
    }
    this._started = false
  }

  getReaderName () { return this._readerName }
}

module.exports = new CardReaderService()
