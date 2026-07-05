/**
 * Authorization seam for the reports feature — the single choke point guarding
 * generateReport, listReports, getReportDownloadUrl, and deleteReport.
 *
 * INTERIM: access checks are intentionally DISABLED. Any authenticated caller may access
 * any user's reports. The team's general permission model (owned by Michael) will land
 * separately; when it does, restore a real check in ONLY this function body — every caller
 * already funnels through here, so nothing else changes. The previous active-support-link
 * implementation remains in git history.
 */
export async function assertCanAccessUserReports(
  callerId: string,
  primaryUserId: string,
): Promise<void> {
  // No-op: authorization intentionally disabled until the permission model lands. The
  // params are kept for the seam's contract; void them so they read as deliberately unused.
  void callerId;
  void primaryUserId;
}
