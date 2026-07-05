import { describe, it, expect } from 'vitest';
import {
  parseProviderAccess,
  resolveProviderAccess,
  DEFAULT_PROVIDER_ACCESS,
} from './provider-access';

describe('provider-access (CONN-0244)', () => {
  describe('parseProviderAccess', () => {
    it('empty / undefined → empty map (everything defaults to fully enabled)', () => {
      expect(parseProviderAccess()).toEqual(new Map());
      expect(parseProviderAccess('')).toEqual(new Map());
      expect(parseProviderAccess('   ')).toEqual(new Map());
    });

    it('level "read" → visible but not routable', () => {
      const m = parseProviderAccess('openmodel:read');
      expect(m.get('openmodel')).toEqual({ read: true, use: false });
    });

    it('level "use" → fully enabled', () => {
      expect(parseProviderAccess('groq:use').get('groq')).toEqual({ read: true, use: true });
    });

    it('level "none" → hidden entirely', () => {
      expect(parseProviderAccess('foo:none').get('foo')).toEqual({ read: false, use: false });
    });

    it('token-less name defaults to fully enabled (use)', () => {
      expect(parseProviderAccess('bar').get('bar')).toEqual({ read: true, use: true });
    });

    it('parses multiple entries and trims whitespace', () => {
      const m = parseProviderAccess(' openmodel:read , groq:use , foo:none ');
      expect(m.get('openmodel')).toEqual({ read: true, use: false });
      expect(m.get('groq')).toEqual({ read: true, use: true });
      expect(m.get('foo')).toEqual({ read: false, use: false });
    });

    it('ignores unknown levels (provider left at default)', () => {
      const m = parseProviderAccess('openmodel:bogus');
      expect(m.has('openmodel')).toBe(false);
    });
  });

  describe('resolveProviderAccess', () => {
    it('unlisted provider → fully-enabled default', () => {
      const m = parseProviderAccess('openmodel:read');
      expect(resolveProviderAccess(m, 'gemini')).toEqual(DEFAULT_PROVIDER_ACCESS);
      expect(resolveProviderAccess(m, 'gemini')).toEqual({ read: true, use: true });
    });

    it('listed provider → its configured access', () => {
      const m = parseProviderAccess('openmodel:read');
      expect(resolveProviderAccess(m, 'openmodel')).toEqual({ read: true, use: false });
    });
  });
});
