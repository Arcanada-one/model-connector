import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { BadRequestException } from '@nestjs/common';

const mockService = {
  createKey: vi.fn(),
  listKeys: vi.fn(),
  revokeKey: vi.fn(),
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
      expect(mockService.createKey).toHaveBeenCalledWith('test', undefined);
    });

    it('should create key with custom rateLimit', async () => {
      mockService.createKey.mockResolvedValue({ id: '1', name: 'test', key: 'mc-abc123' });

      await controller.create({ name: 'test', rateLimit: 200 });

      expect(mockService.createKey).toHaveBeenCalledWith('test', 200);
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

  describe('DELETE /admin/keys/:id', () => {
    it('should call revokeKey with id', async () => {
      mockService.revokeKey.mockResolvedValue(undefined);

      await controller.revoke('uuid-1');

      expect(mockService.revokeKey).toHaveBeenCalledWith('uuid-1');
    });
  });
});
