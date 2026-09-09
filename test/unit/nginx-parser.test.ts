import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMAT } from '../../src/lib/config.ts';
import {
  compileFormat,
  createParser,
  parseLog,
  parseMsec,
  parseRequest,
  parseTimeLocal,
} from '../../src/lib/nginx-parser.ts';

const COMBINED_LINE =
  '10.0.0.1 - - [10/Sep/2026:12:00:01 +0000] "GET /getAddressInfo/0xabc?apiKey=freekey HTTP/1.1" 200 512 "-" "Mozilla/5.0 (bench)"';

describe('parseTimeLocal', () => {
  it('parses nginx time with positive offset', () => {
    expect(parseTimeLocal('10/Sep/2026:12:00:01 +0000')).toBe(Date.UTC(2026, 8, 10, 12, 0, 1));
    expect(parseTimeLocal('10/Sep/2026:14:00:01 +0200')).toBe(Date.UTC(2026, 8, 10, 12, 0, 1));
    expect(parseTimeLocal('10/Sep/2026:07:00:01 -0500')).toBe(Date.UTC(2026, 8, 10, 12, 0, 1));
  });

  it('accepts short offsets as written by nginx (+300 = +03:00) and other forms', () => {
    const noon = Date.UTC(2026, 8, 8, 9, 37, 35);
    expect(parseTimeLocal('08/Sep/2026:12:37:35 +300')).toBe(noon);
    expect(parseTimeLocal('08/Sep/2026:12:37:35 +0300')).toBe(noon);
    expect(parseTimeLocal('08/Sep/2026:12:37:35 +03:00')).toBe(noon);
    expect(parseTimeLocal('08/Sep/2026:12:37:35 +3')).toBe(noon);
    expect(parseTimeLocal('08/Sep/2026:12:37:35 -530')).toBe(Date.UTC(2026, 8, 8, 18, 7, 35));
    expect(parseTimeLocal('08/Sep/2026:09:37:35 Z')).toBe(noon);
  });

  it('accepts missing offset and rejects garbage', () => {
    expect(parseTimeLocal('01/Jan/2026:00:00:00')).toBe(Date.UTC(2026, 0, 1));
    expect(parseTimeLocal('2026-09-10T12:00:01Z')).toBeNull();
    expect(parseTimeLocal('10/Foo/2026:12:00:01 +0000')).toBeNull();
  });
});

describe('parseMsec / parseRequest', () => {
  it('parseMsec converts seconds with fraction', () => {
    expect(parseMsec('1757419200.123')).toBe(1757419200123);
    expect(parseMsec('1757419200')).toBe(1757419200000);
    expect(parseMsec('abc')).toBeNull();
    expect(parseMsec('0')).toBeNull();
  });

  it('parseRequest splits method and path', () => {
    expect(parseRequest('GET /a?b=1 HTTP/1.1')).toEqual({ method: 'GET', path: '/a?b=1' });
    expect(parseRequest('POST /x HTTP/2.0')).toEqual({ method: 'POST', path: '/x' });
    expect(parseRequest('-')).toBeNull();
    expect(parseRequest('\\x16\\x03\\x01 junk')).toBeNull();
    expect(parseRequest('GET http://evil/ HTTP/1.1')).toBeNull();
  });
});

describe('compileFormat', () => {
  it('lists variables in order and matches the combined format', () => {
    const compiled = compileFormat(DEFAULT_FORMAT);
    expect(compiled.variables).toEqual([
      'remote_addr',
      'remote_user',
      'time_local',
      'request',
      'status',
      'body_bytes_sent',
      'http_referer',
      'http_user_agent',
    ]);
    const match = compiled.regex.exec(COMBINED_LINE);
    expect(match?.[4]).toBe('GET /getAddressInfo/0xabc?apiKey=freekey HTTP/1.1');
    expect(match?.[8]).toBe('Mozilla/5.0 (bench)');
  });

  it('escapes literal regex characters in the format', () => {
    const compiled = compileFormat('[$time_local] ($status) $request|$msec');
    expect(compiled.regex.exec('[10/Sep/2026:12:00:01 +0000] (200) GET / HTTP/1.1|1.5')).not.toBeNull();
  });
});

describe('createParser', () => {
  it('parses a combined log line', () => {
    const parser = createParser(DEFAULT_FORMAT);
    expect(parser.parse(COMBINED_LINE)).toEqual({
      method: 'GET',
      path: '/getAddressInfo/0xabc?apiKey=freekey',
      status: 200,
      timestamp: Date.UTC(2026, 8, 10, 12, 0, 1),
      userAgent: 'Mozilla/5.0 (bench)',
    });
  });

  it('parses a production line with HTTP/2 and a short offset', () => {
    const parser = createParser(DEFAULT_FORMAT);
    const entry = parser.parse(
      '107.149.122.66 - - [08/Sep/2026:12:37:35 +300] "GET /getAddressHistory/0x248e4bbffac438dcbf65bfe920fda5ced401dc2c?apiKey=EK-rkL1s-9GCSWWA-hdhLb&type=transfer&limit=50 HTTP/2" 200 2866 "-" "python-requests/2.34.2"',
    );
    expect(entry).toEqual({
      method: 'GET',
      path: '/getAddressHistory/0x248e4bbffac438dcbf65bfe920fda5ced401dc2c?apiKey=EK-rkL1s-9GCSWWA-hdhLb&type=transfer&limit=50',
      status: 200,
      timestamp: Date.UTC(2026, 8, 8, 9, 37, 35),
      userAgent: 'python-requests/2.34.2',
    });
  });

  it('prefers $msec over $time_local when both are present', () => {
    const parser = createParser('$msec [$time_local] "$request" $status');
    const entry = parser.parse('1757419200.250 [10/Sep/2026:12:00:00 +0000] "GET /x HTTP/1.1" 404');
    expect(entry?.timestamp).toBe(1757419200250);
    expect(entry?.status).toBe(404);
    expect(entry?.userAgent).toBe('');
  });

  it('supports custom formats with extra fields', () => {
    const format = '$remote_addr [$time_local] "$request" $status $request_time "$http_user_agent" $upstream_addr';
    const parser = createParser(format);
    const entry = parser.parse('1.2.3.4 [10/Sep/2026:12:00:00 +0000] "GET /a HTTP/1.1" 200 0.123 "ua" 10.0.0.2:8080');
    expect(entry?.path).toBe('/a');
    expect(entry?.userAgent).toBe('ua');
  });

  it('returns null for malformed lines', () => {
    const parser = createParser(DEFAULT_FORMAT);
    expect(parser.parse('garbage')).toBeNull();
    expect(parser.parse('10.0.0.1 - - [bad time] "GET / HTTP/1.1" 200 1 "-" "ua"')).toBeNull();
    expect(parser.parse('10.0.0.1 - - [10/Sep/2026:12:00:01 +0000] "-" 400 0 "-" "-"')).toBeNull();
  });

  it('rejects formats without the mandatory variables', () => {
    expect(() => createParser('$status')).toThrow(/\$request/);
    expect(() => createParser('$request')).toThrow(/time_local/);
  });
});

describe('parseLog', () => {
  it('counts malformed lines and skips blanks', () => {
    const text = `${COMBINED_LINE}\n\nnot a log line\r\n${COMBINED_LINE}\n`;
    const result = parseLog(text, DEFAULT_FORMAT);
    expect(result.entries).toHaveLength(2);
    expect(result.malformed).toBe(1);
  });
});
