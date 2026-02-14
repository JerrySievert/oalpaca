import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

/**
 * Run the token CLI as a subprocess.
 * Returns { stdout, stderr, status }.
 */
function run_cli(args, token_path) {
  const cli_path = join(process.cwd(), 'src', 'token_cli.js');
  const full_args = [...args, '--tokens-file', token_path];

  try {
    const stdout = execFileSync('node', [cli_path, ...full_args], {
      encoding: 'utf-8',
      timeout: 10000
    });
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      status: error.status
    };
  }
}

describe('token_cli', () => {
  let tmp_dir;
  let token_path;

  beforeEach(() => {
    tmp_dir = mkdtempSync(join(tmpdir(), 'llama-cli-test-'));
    token_path = join(tmp_dir, 'tokens.json');
  });

  describe('create', () => {
    it('creates a token with note and models', () => {
      const { stdout, status } = run_cli(
        ['create', '--note', 'Test device', '--models', 'baseball,assistant'],
        token_path
      );
      expect(status).toBe(0);
      expect(stdout).toContain('Token created successfully');
      expect(stdout).toContain('Test device');
      expect(stdout).toContain('baseball');
    });

    it('fails without --models', () => {
      const { status, stderr } = run_cli(
        ['create', '--note', 'No models'],
        token_path
      );
      expect(status).not.toBe(0);
      expect(stderr).toContain('--models is required');
    });
  });

  describe('list', () => {
    it('shows no tokens message when empty', () => {
      const { stdout, status } = run_cli(['list'], token_path);
      expect(status).toBe(0);
      expect(stdout).toContain('No tokens found');
    });

    it('lists created tokens', () => {
      run_cli(['create', '--note', 'First', '--models', 'a'], token_path);
      run_cli(['create', '--note', 'Second', '--models', 'b'], token_path);

      const { stdout, status } = run_cli(['list'], token_path);
      expect(status).toBe(0);
      expect(stdout).toContain('First');
      expect(stdout).toContain('Second');
      expect(stdout).toContain('2 token(s) total');
    });
  });

  describe('revoke', () => {
    it('revokes an existing token', () => {
      const { stdout: create_out } = run_cli(
        ['create', '--note', 'Temp', '--models', 'x'],
        token_path
      );
      // Extract token from output
      const token_match = create_out.match(/Token:\s+([a-f0-9]{64})/);
      expect(token_match).not.toBeNull();
      const token = token_match[1];

      const { stdout, status } = run_cli(['revoke', token], token_path);
      expect(status).toBe(0);
      expect(stdout).toContain('Token revoked successfully');
    });

    it('fails for non-existent token', () => {
      const { status, stderr } = run_cli(['revoke', 'nonexistent'], token_path);
      expect(status).not.toBe(0);
      expect(stderr).toContain('token not found');
    });

    it('fails when no token argument provided', () => {
      const { status, stderr } = run_cli(['revoke'], token_path);
      expect(status).not.toBe(0);
      expect(stderr).toContain('token argument is required');
    });
  });

  describe('update', () => {
    let token;

    beforeEach(() => {
      const { stdout } = run_cli(
        ['create', '--note', 'Original', '--models', 'a'],
        token_path
      );
      const match = stdout.match(/Token:\s+([a-f0-9]{64})/);
      token = match[1];
    });

    it('updates note', () => {
      const { stdout, status } = run_cli(
        ['update', token, '--note', 'Updated note'],
        token_path
      );
      expect(status).toBe(0);
      expect(stdout).toContain('Token updated successfully');
      expect(stdout).toContain('Updated note');
    });

    it('updates models', () => {
      const { stdout, status } = run_cli(
        ['update', token, '--models', 'a,b,c'],
        token_path
      );
      expect(status).toBe(0);
      expect(stdout).toContain('a, b, c');
    });

    it('fails for non-existent token', () => {
      const { status, stderr } = run_cli(
        ['update', 'nonexistent', '--note', 'x'],
        token_path
      );
      expect(status).not.toBe(0);
      expect(stderr).toContain('token not found');
    });

    it('fails when no update fields provided', () => {
      const { status, stderr } = run_cli(['update', token], token_path);
      expect(status).not.toBe(0);
      expect(stderr).toContain('provide --note and/or --models');
    });

    it('fails when no token argument provided', () => {
      const { status, stderr } = run_cli(['update', '--note', 'x'], token_path);
      expect(status).not.toBe(0);
    });
  });

  describe('help / unknown command', () => {
    it('shows usage for no command', () => {
      const { stdout } = run_cli([], token_path);
      expect(stdout).toContain('Token Management CLI');
    });

    it('exits with error for unknown command', () => {
      const { status } = run_cli(['foobar'], token_path);
      expect(status).not.toBe(0);
    });
  });
});
