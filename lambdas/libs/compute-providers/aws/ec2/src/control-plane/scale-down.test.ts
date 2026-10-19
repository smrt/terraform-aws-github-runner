import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunnerInfo, RunnerType } from '../../../../core';
import { IDLE_DETECTED_TAG, createEc2ScaleDownProvider } from './scale-down';
import { describeRunner, listEC2Runners, tag, terminateRunner, untag } from './runners';

vi.mock('./runners', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runners')>();
  return {
    ...actual,
    describeRunner: vi.fn(),
    listEC2Runners: vi.fn(),
    tag: vi.fn(),
    terminateRunner: vi.fn(),
    untag: vi.fn(),
  };
});

const mockListRunners = vi.mocked(listEC2Runners);
const mockDescribeRunner = vi.mocked(describeRunner);
const mockTagRunner = vi.mocked(tag);
const mockTerminateRunner = vi.mocked(terminateRunner);
const mockUntagRunner = vi.mocked(untag);

describe('Scale down runners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const endpoints = ['https://api.github.com', 'https://github.enterprise.something', 'https://companyname.ghe.com'];

  describe.each(endpoints)('for %s', () => {
    const runnerTypes: RunnerType[] = ['Org', 'Repo'];

    describe.each(runnerTypes)('For %s runners.', (type) => {
      const runner: RunnerInfo = {
        id: `i-runner-${type.toLowerCase()}`,
        launchTime: new Date('2026-08-05T10:00:00.000Z'),
        owner: type === 'Repo' ? 'Codertocat/hello-world' : 'Codertocat',
        type,
        repo: 'hello-world',
        org: 'Codertocat',
        orphan: true,
        githubRunnerId: '1234567890',
        bypassRemoval: true,
      };

      it('Should not call terminate when no runners online.', async () => {
        mockListRunners.mockResolvedValueOnce([]).mockResolvedValueOnce([runner]);
        mockTagRunner.mockResolvedValue();
        mockUntagRunner.mockResolvedValue();
        const provider = createEc2ScaleDownProvider();

        await expect(provider.list('unit-test-environment')).resolves.toEqual([]);
        await expect(provider.list('unit-test-environment', true)).resolves.toEqual([runner]);
        expect(mockListRunners).toHaveBeenNthCalledWith(1, {
          environment: 'unit-test-environment',
          orphan: undefined,
        });
        expect(mockListRunners).toHaveBeenNthCalledWith(2, { environment: 'unit-test-environment', orphan: true });
        expect(mockTerminateRunner).not.toHaveBeenCalled();

        await provider.markOrphan(runner.id);
        await provider.unmarkOrphan(runner.id);

        expect(mockTagRunner).toHaveBeenCalledWith(runner.id, [{ Key: 'ghr:orphan', Value: 'true' }]);
        expect(mockUntagRunner).toHaveBeenCalledWith(runner.id, [{ Key: 'ghr:orphan', Value: 'true' }]);
      });

      it('Should re-read a single runner through DescribeInstances.', async () => {
        mockDescribeRunner.mockResolvedValueOnce({ ...runner, bypassRemoval: false }).mockResolvedValueOnce(undefined);
        const provider = createEc2ScaleDownProvider();

        await expect(provider.describe(runner.id)).resolves.toEqual({ ...runner, bypassRemoval: false });
        await expect(provider.describe('i-gone')).resolves.toBeUndefined();
        expect(mockDescribeRunner).toHaveBeenNthCalledWith(1, runner.id);
        expect(mockDescribeRunner).toHaveBeenNthCalledWith(2, 'i-gone');
      });

      it('Should persist and clear the idle-detection marker as an instance tag.', async () => {
        mockTagRunner.mockResolvedValue();
        mockUntagRunner.mockResolvedValue();
        const detectedAt = '2026-08-05T10:05:00.000Z';
        const provider = createEc2ScaleDownProvider();

        await provider.markIdle(runner.id, detectedAt);
        await provider.unmarkIdle(runner.id);

        expect(mockTagRunner).toHaveBeenCalledWith(runner.id, [{ Key: IDLE_DETECTED_TAG, Value: detectedAt }]);
        expect(mockUntagRunner).toHaveBeenCalledWith(runner.id, [{ Key: IDLE_DETECTED_TAG }]);
        expect(mockTerminateRunner).not.toHaveBeenCalled();
      });

      it(`Should respect booting runner.`, async () => {
        const scaleDownRunner: RunnerInfo = {
          ...runner,
          launchTime: new Date(),
        };
        process.env.RUNNER_BOOT_TIME_IN_MINUTES = '5';
        const provider = createEc2ScaleDownProvider();

        expect(provider.bootTimeExceeded(scaleDownRunner)).toBe(false);
        expect(mockTerminateRunner).not.toHaveBeenCalled();
        mockTerminateRunner.mockResolvedValue();
        await provider.terminate(runner.id);

        expect(mockTerminateRunner).toHaveBeenCalledWith(runner.id);
      });
    });
  });
});
