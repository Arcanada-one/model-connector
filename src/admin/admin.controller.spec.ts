import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { BadRequestException } from '@nestjs/common';

const mockService = {
  createKey: vi.fn(),
  listKeys: vi.fn(),
  revokeKey: vi.fn(),
  setKeyPolicy: vi.fn(),
};

describe('AdminController', () => {
  let controller: AdminController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new AdminController(mockService as unknown as AdminService);
  });

  describe('POST /admin/keys', () => {
    it('should create key with valid body', async () => {
      mockService.createKey.mockResolvedValue({ id: '1', name: 'test', key: 'mc-abc123' });

      const result = await controller.create({ name: 'test' });

      expect(result).toEqual({ id: '1', name: 'test', key: 'mc-abc123' });
      expect(mockService.createKey).toHaveBeenCalledWith('test', undefined, undefined);
    });

    it('should create key with custom rateLimit', async () => {
      mockService.createKey.mockResolvedValue({ id: '1', name: 'test', key: 'mc-abc123' });

      await controller.create({ name: 'test', rateLimit: 200 });

      expect(mockService.createKey).toHaveBeenCalledWith('test', 200, undefined);
    });

    // ── CONN-1665 — optional policy, validated at WRITE time ──
    it('should create key with a valid policy and pass it through', async () => {
      mockService.createKey.mockResolvedValue({ id: '1', name: 'test', key: 'mc-abc123' });
      const policy = {
        policyVersion: 1,
        providers: ['openrouter'],
        models: { mode: 'free-only' },
      };

      await controller.create({ name: 'test', policy });

      expect(mockService.createKey).toHaveBeenCalledWith('test', undefined, policy);
    });

    it('should reject a malformed policy BEFORE the service is called', async () => {
      await expect(
        controller.create({ name: 'test', policy: { policyVersion: 2 } }),
      ).rejects.toThrow(BadRequestException);
      expect(mockService.createKey).not.toHaveBeenCalled();
    });

    it('should reject providerKeys naming a non-override-capable provider', async () => {
      await expect(
        controller.create({
          name: 'test',
          policy: { policyVersion: 1, providerKeys: { groq: 'GROQ_API_KEY_X' } },
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockService.createKey).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException for missing name', async () => {
      await expect(controller.create({})).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for empty name', async () => {
      await expect(controller.create({ name: '' })).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for invalid rateLimit', async () => {
      await expect(controller.create({ name: 'test', rateLimit: -1 })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('GET /admin/keys', () => {
    it('should return list of keys', async () => {
      const keys = [{ id: '1', name: 'key-a', rateLimit: 60, active: true, createdAt: new Date() }];
      mockService.listKeys.mockResolvedValue(keys);

      const result = await controller.list();

      expect(result).toEqual(keys);
    });
  });

  // ── CONN-1665 — PATCH /admin/keys/:id/policy ──
  describe('PATCH /admin/keys/:id/policy', () => {
    it('sets a valid policy', async () => {
      mockService.setKeyPolicy.mockResolvedValue({ id: 'uuid-1' });
      const policy = { policyVersion: 1, models: { mode: 'free-only' } };

      const result = await controller.setPolicy('uuid-1', { policy });

      expect(result).toEqual({ id: 'uuid-1' });
      expect(mockService.setKeyPolicy).toHaveBeenCalledWith('uuid-1', policy);
    });

    it('clears the policy with null', async () => {
      mockService.setKeyPolicy.mockResolvedValue({ id: 'uuid-1' });

      await controller.setPolicy('uuid-1', { policy: null });

      expect(mockService.setKeyPolicy).toHaveBeenCalledWith('uuid-1', null);
    });

    it('rejects malformed policies before the service is called', async () => {
      for (const bad of [
        {},
        { policy: { policyVersion: 1, models: { mode: 'list' } } },
        { policy: { policyVersion: 1, providerKeys: { openrouter: 'sk-live-value' } } },
      ]) {
        await expect(controller.setPolicy('uuid-1', bad)).rejects.toThrow(BadRequestException);
      }
      expect(mockService.setKeyPolicy).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /admin/keys/:id', () => {
    it('should call revokeKey with id', async () => {
      mockService.revokeKey.mockResolvedValue(undefined);

      await controller.revoke('uuid-1');

      expect(mockService.revokeKey).toHaveBeenCalledWith('uuid-1');
    });
  });
});
