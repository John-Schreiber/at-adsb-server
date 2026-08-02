import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AtpAgent } from '@atproto/api';
import { generateStreamKey } from '../cli.js';
import * as clientModule from '../client.js';

// Mock the client module
vi.mock('../client.js');

describe('CLI: generate-stream-key command', () => {
  let mockAgent: AtpAgent;

  beforeEach(() => {
    // Mock agent
    mockAgent = {
      api: {},
    } as unknown as AtpAgent;

    // Mock createAgent
    vi.mocked(clientModule.createAgent).mockResolvedValue(mockAgent);

    // Mock putRecord to capture the station record update
    vi.mocked(clientModule.putRecord).mockResolvedValue({
      uri: 'at://did:plc:test/at.adsb.receiver.station/self',
      cid: 'cid-test',
    });

    vi.clearAllMocks();
  });

  describe('AC1.1: Happy path — generate keypair and output', () => {
    it('should generate a keypair, output did:key and hex, and update station record', async () => {
      // Mock getRecord to return a valid station record
      vi.mocked(clientModule.getRecord).mockResolvedValue({
        uri: 'at://did:plc:test/at.adsb.receiver.station/self',
        cid: 'cid-station',
        value: {
          $type: 'at.adsb.receiver.station',
          displayName: 'Test Station',
          latitude: '37.5',
          longitude: '-122.5',
          createdAt: '2026-05-25T00:00:00Z',
        },
      });

      // Call the actual production function
      const { didKey, privateHex } = await generateStreamKey(mockAgent);

      // Verify outputs
      expect(didKey).toMatch(/^did:key:z/);
      expect(privateHex).toMatch(/^[0-9a-f]{64}$/);

      // Verify putRecord was called
      expect(vi.mocked(clientModule.putRecord)).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC1.2: Station record updated with did:key', () => {
    it('should update the station record with streamSigningKey field matching did:key pattern', async () => {
      // Mock getRecord to return a valid station record
      vi.mocked(clientModule.getRecord).mockResolvedValue({
        uri: 'at://did:plc:test/at.adsb.receiver.station/self',
        cid: 'cid-station',
        value: {
          $type: 'at.adsb.receiver.station',
          displayName: 'Test Station',
          latitude: '37.5',
          longitude: '-122.5',
          createdAt: '2026-05-25T00:00:00Z',
        },
      });

      // Call the actual production function
      const { didKey } = await generateStreamKey(mockAgent);

      // Verify the record passed to putRecord contains the did:key
      const calls = vi.mocked(clientModule.putRecord).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const callArg = calls[0];
      expect(callArg).toBeDefined();
      if (!callArg) throw new Error('callArg is undefined');
      const recordArg = callArg[3] as Record<string, unknown>;

      expect(recordArg['streamSigningKey']).toMatch(/^did:key:z/);
      expect(recordArg['streamSigningKey']).toBe(didKey);
    });

    it('should preserve existing station record fields when updating', async () => {
      const originalRecord = {
        $type: 'at.adsb.receiver.station',
        displayName: 'My Station',
        latitude: '37.5',
        longitude: '-122.5',
        altitude: 10,
        locationName: 'San Francisco',
        createdAt: '2026-05-25T00:00:00Z',
      };

      vi.mocked(clientModule.getRecord).mockResolvedValue({
        uri: 'at://did:plc:test/at.adsb.receiver.station/self',
        cid: 'cid-station',
        value: originalRecord,
      });

      // Call the actual production function
      const { didKey } = await generateStreamKey(mockAgent);

      // Verify all original fields are preserved
      const calls = vi.mocked(clientModule.putRecord).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const callArg = calls[0];
      expect(callArg).toBeDefined();
      if (!callArg) throw new Error('callArg is undefined');
      const recordArg = callArg[3] as Record<string, unknown>;

      expect(recordArg['displayName']).toBe('My Station');
      expect(recordArg['latitude']).toBe('37.5');
      expect(recordArg['longitude']).toBe('-122.5');
      expect(recordArg['altitude']).toBe(10);
      expect(recordArg['locationName']).toBe('San Francisco');
      expect(recordArg['createdAt']).toBe('2026-05-25T00:00:00Z');
      expect(recordArg['streamSigningKey']).toBe(didKey);
      expect(recordArg['$type']).toBeUndefined(); // Should be removed
    });
  });

  describe('AC1.4: Graceful failure when station record does not exist', () => {
    it('should throw error when getRecord returns null', async () => {
      // Mock getRecord to return null (no station record)
      vi.mocked(clientModule.getRecord).mockResolvedValue(null);

      // Call the production function and expect it to throw
      await expect(generateStreamKey(mockAgent)).rejects.toThrow(
        'No station record found. Run \'at-adsb register\' first.',
      );

      // Verify putRecord was not called
      expect(vi.mocked(clientModule.putRecord)).not.toHaveBeenCalled();
    });
  });

  describe('Integration: Multiple successful key generations', () => {
    it('should handle multiple consecutive key generations', async () => {
      vi.mocked(clientModule.getRecord).mockResolvedValue({
        uri: 'at://did:plc:test/at.adsb.receiver.station/self',
        cid: 'cid-station',
        value: {
          $type: 'at.adsb.receiver.station',
          displayName: 'Test Station',
          latitude: '37.5',
          longitude: '-122.5',
          createdAt: '2026-05-25T00:00:00Z',
        },
      });

      // Generate two different keys
      const { didKey: didKey1 } = await generateStreamKey(mockAgent);

      // Reset mocks and call again
      vi.clearAllMocks();
      vi.mocked(clientModule.getRecord).mockResolvedValue({
        uri: 'at://did:plc:test/at.adsb.receiver.station/self',
        cid: 'cid-station',
        value: {
          $type: 'at.adsb.receiver.station',
          displayName: 'Test Station',
          latitude: '37.5',
          longitude: '-122.5',
          createdAt: '2026-05-25T00:00:00Z',
        },
      });
      vi.mocked(clientModule.putRecord).mockResolvedValue({
        uri: 'at://did:plc:test/at.adsb.receiver.station/self',
        cid: 'cid-test',
      });

      const { didKey: didKey2 } = await generateStreamKey(mockAgent);

      // Keys should be different
      expect(didKey1).not.toBe(didKey2);
      expect(didKey1).toMatch(/^did:key:z/);
      expect(didKey2).toMatch(/^did:key:z/);
    });
  });
});
