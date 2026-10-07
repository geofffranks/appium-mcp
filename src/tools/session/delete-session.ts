import {safeDeleteSession} from '../../session-store.js';
import {
  verifySessionDeleteBinding,
  recordDeletedSession,
  type ManagedSessionArgs,
} from '../../utils/managed-session.js';
import {errorResult, textResult, toolErrorMessage} from '../tool-response.js';

export async function deleteSessionAction(sessionId?: string, args: ManagedSessionArgs = {}): Promise<any> {
  try {
    const managed = await verifySessionDeleteBinding(sessionId, args);
    const deleted = await safeDeleteSession(sessionId);
    if (deleted) {
      if (managed) {
        await recordDeletedSession(managed, args.operationId!);
      }
      return textResult(
        sessionId ? `Session ${sessionId} deleted successfully.` : 'Active session deleted successfully.',
      );
    }

    return errorResult(
      sessionId
        ? `Session ${sessionId} not found or deletion already in progress.`
        : 'No active session found or deletion already in progress.',
    );
  } catch (error: unknown) {
    return errorResult(`Failed to delete session. ${toolErrorMessage(error)}`);
  }
}
