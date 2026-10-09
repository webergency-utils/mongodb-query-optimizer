import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = resolve(process.cwd(), '.github/workflows/ci.yml');

describe('CI mock contract', () =>
{
    it('uses Node 24 and pure in-memory mock testing without real MongoDB in CI', async () =>
    {
        const workflow = await readFile(workflowPath, 'utf8');

        expect(workflow).toContain('node-version: 24');
        expect(workflow).not.toContain('MONGODB_URI');
        expect(workflow).not.toMatch(/mongodb(?:\+srv)?:\/\//i);
        expect(workflow).not.toMatch(/\bservices:|\bdocker\b|\bapt-get\b|\bbrew\b/);
        expect(workflow).not.toContain('environment: mongodb-query-optimizer-tests');
        expect(workflow).toContain('run: npm test');
        expect(workflow).toContain('run: npm run coverage');
        expect(workflow).toContain('run: npm run build');
    });

    it('runs the complete command path with immutable action references', async () =>
    {
        const workflow = await readFile(workflowPath, 'utf8');
        const actionReferences = Array.from(
            workflow.matchAll(/uses:\s+\S+@(\S+)/g),
            (match) => match[1]!,
        );

        expect(actionReferences.length).toBeGreaterThan(0);
        for (const reference of actionReferences)
        {
            expect(reference).toMatch(/^[0-9a-f]{40}$/);
        }
    });
});
