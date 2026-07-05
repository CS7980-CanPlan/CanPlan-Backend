import { assertCanAccessUserReports } from './reportAuthz';

// INTERIM: authorization is intentionally disabled — the seam is a no-op that resolves for
// any caller. When the permission model lands, restore behavior-driven tests here.
describe('assertCanAccessUserReports (disabled)', () => {
  it('resolves for any caller/user without touching the database', async () => {
    await expect(assertCanAccessUserReports('anyone', 'any-user')).resolves.toBeUndefined();
  });
});
