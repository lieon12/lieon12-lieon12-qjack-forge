// pkt.ts — git pkt-line framing and sideband chunking.
// A pkt-line is a 4-hex length prefix (including itself) + payload.
// Special lines: flush '0000', delim '0001', response-end '0002'.
// Sideband: each pkt-line's payload starts with a band byte (1 = data,
// 2 = progress, 3 = error); pack bytes ride in band 1. A sideband packet
// holds at most 65,520 bytes total, so pack chunks are at most 65,516.

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const RESPONSE_END = Buffer.from('0002', 'ascii');

const MAX_PKT = 65520;
export const MAX_SIDEBAND_DATA = MAX_PKT - 4 - 1; // 65,515 usable pack bytes per packet

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktLines(items: Array<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else if (item === 'response-end') parts.push(RESPONSE_END);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Split a byte stream into sideband band-1 packets (each <= 65,520 bytes). */
export function sidebandPackets(data: Buffer, band = 1): Buffer {
  if (data.length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for (let off = 0; off < data.length; off += MAX_SIDEBAND_DATA) {
    const chunk = data.subarray(off, off + MAX_SIDEBAND_DATA);
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Incremental pkt-line decoder for request bodies (handles split TCP chunks). */
export class PktLineDecoder {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
  }

  next(): Packet | null {
    if (this.buf.length < 4) return null;
    const head = this.buf.subarray(0, 4).toString('ascii');
    if (head === '0000') {
      this.buf = this.buf.subarray(4);
      return { kind: 'flush' };
    }
    if (head === '0001') {
      this.buf = this.buf.subarray(4);
      return { kind: 'delim' };
    }
    if (head === '0002') {
      this.buf = this.buf.subarray(4);
      return { kind: 'response-end' };
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || len > MAX_PKT) return null;
    if (this.buf.length < len) return null;
    const payload = this.buf.subarray(4, len);
    this.buf = this.buf.subarray(len);
    return { kind: 'data', payload: Buffer.from(payload) };
  }

  /** Everything left over after the pkt-lines: the raw pack bytes of a push. */
  rest(): Buffer {
    return this.buf;
  }
}

/** Decode a whole buffer of pkt-lines (used for small requests). */
export function decodeAll(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const dec = new PktLineDecoder();
  dec.push(buf);
  const packets: Packet[] = [];
  for (;;) {
    const p = dec.next();
    if (p === null) break;
    packets.push(p);
  }
  return { packets, rest: dec.rest() };
}
