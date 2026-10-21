import { test, expect } from 'bun:test';
import { headerInputId, peerHeader } from '../src/delivery';

const sessionId = '7568b073-35bf-47a4-95d8-15ad095c4b31';
const inputId = '95357a4f-b3db-42cc-b098-98b89ea95f19';

test('the header names a plain sender and, on the app-server path, the input', () => {
  expect(peerHeader(sessionId, 'asb-general-support'))
    .toBe(`[ASB Bridge peer message from asb-general-support, sessionId ${sessionId}. Reply with send_message.]`);
  expect(peerHeader(sessionId, 'asb-general-support', inputId))
    .toBe(`[ASB Bridge peer message ${inputId} from asb-general-support, sessionId ${sessionId}. Reply with send_message.]`);
  expect(peerHeader(sessionId, 'x'.repeat(64))).toContain(`from ${'x'.repeat(64)}, sessionId`);
  expect(peerHeader(sessionId, 'a.b_C-9')).toContain('from a.b_C-9, sessionId');
});

test.each(['has space', 'a]b', 'line\nbreak', 'trailing\n', 'x'.repeat(65), '', 'Claude Code', undefined])(
  'the name %p is left out of the header', name => {
    expect(peerHeader(sessionId, name)).toBe(`[ASB Bridge peer message from sessionId ${sessionId}. Reply with send_message.]`);
    expect(peerHeader(sessionId, name, inputId)).toBe(`[ASB Bridge peer message ${inputId} from sessionId ${sessionId}. Reply with send_message.]`);
  });

test('the header line gives its input only at the start of the output', () => {
  const header = peerHeader(sessionId, 'asb-general-support', inputId);
  expect(headerInputId(`${header}\nbody`)).toBe(inputId);
  expect(headerInputId(`${header}\n${peerHeader(sessionId, undefined, sessionId)}`)).toBe(inputId);
  expect(headerInputId(` ${header}`)).toBeUndefined();
  expect(headerInputId(`body\n${header}`)).toBeUndefined();
  expect(headerInputId(peerHeader(sessionId, 'asb-general-support'))).toBeUndefined();
  expect(headerInputId(JSON.stringify({ inputId, content: 'x' }))).toBeUndefined();
});
