import { beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal chrome.* stub: enough for cdp.ts to load and talk to "the debugger".
const attach = vi.fn(async () => {});
const sendCommand = vi.fn(async () => ({}));
const detach = vi.fn(async () => {});
vi.stubGlobal('chrome', {
  debugger: { attach, sendCommand, detach, onDetach: { addListener: () => {} } },
  tabs: { onRemoved: { addListener: () => {} } },
});

const cdp = await import('../src/background/cdp');
const { CommandError, Code } = await import('../src/shared/protocol');

describe('kill switch in the CDP layer', () => {
  beforeEach(() => {
    attach.mockClear();
    sendCommand.mockClear();
    cdp.block(null);
  });

  it('refuses to attach or send while paused, so in-flight actions stop', async () => {
    cdp.block(new CommandError(Code.PAUSED, 'paused by the user'));
    await expect(cdp.click(7, 10, 10)).rejects.toMatchObject({ code: 'PAUSED' });
    expect(attach).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('detaches again if Stop lands while attaching', async () => {
    attach.mockImplementationOnce(async () => {
      cdp.block(new CommandError(Code.PAUSED, 'paused while attaching'));
    });
    await expect(cdp.insertText(9, 'x')).rejects.toMatchObject({ code: 'PAUSED' });
    expect(detach).toHaveBeenCalledWith({ tabId: 9 });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('stops between the steps of a multi-event action', async () => {
    await cdp.insertText(7, 'ok'); // attached and working
    sendCommand.mockImplementationOnce(async () => {
      cdp.block(new CommandError(Code.PAUSED, 'paused mid-action'));
      return {};
    });
    await expect(cdp.click(7, 1, 1, 'left', 3)).rejects.toMatchObject({ code: 'PAUSED' });
    // mouseMoved went out, then the pause hit: none of the 6 press/release events followed.
    const methods = sendCommand.mock.calls.map((c) => (c as unknown[])[1]);
    expect(methods.filter((m) => m === 'Input.dispatchMouseEvent')).toHaveLength(1);
  });
});
