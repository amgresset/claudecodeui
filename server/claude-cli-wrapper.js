/**
 * Claude CLI Wrapper
 *
 * This module provides CLI-based integration with Claude Code using the actual `claude` binary.
 * This uses your Claude Max subscription instead of paying for API calls separately.
 *
 * Key features:
 * - Uses real `claude` CLI with --print mode
 * - Session management via --continue and --resume flags
 * - Streams JSONL output to WebSocket
 * - Supports abort via process kill
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import readline from 'readline';

// Session tracking: Map of session IDs to active child processes
const activeSessions = new Map();

/**
 * Builds CLI arguments from options
 * @param {string} command - User prompt
 * @param {Object} options - Query options
 * @returns {Array<string>} CLI arguments
 */
function buildCliArgs(command, options = {}) {
  const args = ['--print', '--output-format', 'stream-json'];

  // Resume existing session
  if (options.sessionId) {
    args.push('--resume', options.sessionId);
  }

  // Add allowed tools
  if (options.toolsSettings?.allowedTools?.length > 0) {
    args.push('--allowedTools', options.toolsSettings.allowedTools.join(','));
  }

  // Add disallowed tools
  if (options.toolsSettings?.disallowedTools?.length > 0) {
    args.push('--disallowedTools', options.toolsSettings.disallowedTools.join(','));
  }

  // Add model if specified
  if (options.model) {
    args.push('--model', options.model);
  }

  // Add the prompt
  args.push(command);

  return args;
}

/**
 * Handles image processing - saves base64 images to temp files
 * @param {string} command - Original user prompt
 * @param {Array} images - Array of image objects with base64 data
 * @param {string} cwd - Working directory
 * @returns {Promise<Object>} {modifiedCommand, tempImagePaths, tempDir}
 */
async function handleImages(command, images, cwd) {
  const tempImagePaths = [];
  let tempDir = null;

  if (!images || images.length === 0) {
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }

  try {
    const workingDir = cwd || process.cwd();
    tempDir = path.join(workingDir, '.tmp', 'images', Date.now().toString());
    await fs.mkdir(tempDir, { recursive: true });

    for (const [index, image] of images.entries()) {
      const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        console.error('Invalid image data format');
        continue;
      }

      const [, mimeType, base64Data] = matches;
      const extension = mimeType.split('/')[1] || 'png';
      const filename = `image_${index}.${extension}`;
      const filepath = path.join(tempDir, filename);

      await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
      tempImagePaths.push(filepath);
    }

    let modifiedCommand = command;
    if (tempImagePaths.length > 0 && command?.trim()) {
      const imageNote = `\n\n[Images provided at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
      modifiedCommand = command + imageNote;
    }

    console.log(`📸 Processed ${tempImagePaths.length} images to temp directory: ${tempDir}`);
    return { modifiedCommand, tempImagePaths, tempDir };
  } catch (error) {
    console.error('Error processing images:', error);
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }
}

/**
 * Cleans up temporary image files
 * @param {Array<string>} tempImagePaths - Temp file paths to delete
 * @param {string} tempDir - Temp directory to remove
 */
async function cleanupTempFiles(tempImagePaths, tempDir) {
  if (!tempImagePaths || tempImagePaths.length === 0) return;

  try {
    for (const imagePath of tempImagePaths) {
      await fs.unlink(imagePath).catch(() => {});
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    console.log(`🧹 Cleaned up ${tempImagePaths.length} temp image files`);
  } catch (error) {
    console.error('Error during temp file cleanup:', error);
  }
}

/**
 * Executes a Claude query using the CLI
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws) {
  const { sessionId } = options;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;
  let tempImagePaths = [];
  let tempDir = null;

  try {
    // Handle images
    const imageResult = await handleImages(command, options.images, options.cwd);
    const finalCommand = imageResult.modifiedCommand;
    tempImagePaths = imageResult.tempImagePaths;
    tempDir = imageResult.tempDir;

    // Build CLI arguments
    const args = buildCliArgs(finalCommand, options);

    console.log('🚀 Spawning claude CLI:', 'claude', args.slice(0, 4).join(' '), '...');

    // Spawn the claude process
    const claudeProcess = spawn('claude', args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Track the process for abort capability
    const processSessionId = capturedSessionId || `pending_${Date.now()}`;
    activeSessions.set(processSessionId, {
      process: claudeProcess,
      startTime: Date.now(),
      status: 'active',
      tempImagePaths,
      tempDir
    });

    // Create readline interface for JSONL parsing
    const rl = readline.createInterface({
      input: claudeProcess.stdout,
      crlfDelay: Infinity
    });

    // Process each line of JSONL output
    rl.on('line', (line) => {
      if (!line.trim()) return;

      try {
        const message = JSON.parse(line);

        // Capture session ID from messages
        if (message.session_id && !capturedSessionId) {
          capturedSessionId = message.session_id;

          // Update session tracking with real ID
          const session = activeSessions.get(processSessionId);
          if (session) {
            activeSessions.delete(processSessionId);
            activeSessions.set(capturedSessionId, session);
          }

          // Set session ID on writer if available
          if (ws.setSessionId && typeof ws.setSessionId === 'function') {
            ws.setSessionId(capturedSessionId);
          }

          // Send session-created event for new sessions
          if (!sessionId && !sessionCreatedSent) {
            sessionCreatedSent = true;
            ws.send(JSON.stringify({
              type: 'session-created',
              sessionId: capturedSessionId
            }));
          }
        }

        // Send message to WebSocket
        ws.send(JSON.stringify({
          type: 'claude-response',
          data: message
        }));

        // Extract token budget from result messages
        if (message.type === 'result' && message.total_cost_usd !== undefined) {
          // CLI provides cost, we can estimate tokens or just show cost
          console.log(`📊 Cost: $${message.total_cost_usd}`);
        }

      } catch (parseError) {
        // Not JSON, might be regular output - send as text message
        console.log('📝 Non-JSON output:', line.substring(0, 100));
        ws.send(JSON.stringify({
          type: 'claude-response',
          data: {
            type: 'assistant',
            content: [{ type: 'text', text: line }]
          }
        }));
      }
    });

    // Handle stderr
    let stderrBuffer = '';
    claudeProcess.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
      console.error('Claude stderr:', data.toString());
    });

    // Handle process completion
    await new Promise((resolve, reject) => {
      claudeProcess.on('close', (code) => {
        console.log(`✅ Claude process exited with code ${code}`);

        // Clean up session
        if (capturedSessionId) {
          activeSessions.delete(capturedSessionId);
        } else {
          activeSessions.delete(processSessionId);
        }

        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Claude exited with code ${code}: ${stderrBuffer}`));
        }
      });

      claudeProcess.on('error', (error) => {
        console.error('Claude process error:', error);
        reject(error);
      });
    });

    // Clean up temp files
    await cleanupTempFiles(tempImagePaths, tempDir);

    // Send completion event
    console.log('✅ Streaming complete, sending claude-complete event');
    ws.send(JSON.stringify({
      type: 'claude-complete',
      sessionId: capturedSessionId,
      exitCode: 0,
      isNewSession: !sessionId && !!command
    }));

  } catch (error) {
    console.error('CLI query error:', error);

    // Clean up session on error
    if (capturedSessionId) {
      activeSessions.delete(capturedSessionId);
    }

    // Clean up temp files
    await cleanupTempFiles(tempImagePaths, tempDir);

    // Send error to WebSocket
    ws.send(JSON.stringify({
      type: 'claude-error',
      error: error.message
    }));

    throw error;
  }
}

/**
 * Aborts an active CLI session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = activeSessions.get(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`🛑 Aborting CLI session: ${sessionId}`);

    // Kill the process
    if (session.process && !session.process.killed) {
      session.process.kill('SIGTERM');

      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (!session.process.killed) {
          session.process.kill('SIGKILL');
        }
      }, 5000);
    }

    // Update session status
    session.status = 'aborted';

    // Clean up temp files
    await cleanupTempFiles(session.tempImagePaths, session.tempDir);

    // Remove from active sessions
    activeSessions.delete(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    return false;
  }
}

/**
 * Checks if a CLI session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = activeSessions.get(sessionId);
  return session && session.status === 'active';
}

/**
 * Gets all active CLI session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return Array.from(activeSessions.keys());
}

// Export public API (same interface as claude-sdk.js)
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions
};
