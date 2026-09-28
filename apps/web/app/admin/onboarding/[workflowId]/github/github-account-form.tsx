"use client";

import type { GitHubIdentityStatus } from "@aoo/shared";
import { useState, type FormEvent } from "react";

/** HR-facing status: "Not provided", resolved, invitation pending or provisioned. */
export function statusLines(status: GitHubIdentityStatus): string[] {
  const lines: string[] = [];
  if (status.identity.state === "NOT_SUBMITTED") lines.push("Not provided");
  if (status.identity.state === "SUBMITTED") {
    lines.push(`Username recorded: ${status.identity.claimedLogin} (not yet resolved at GitHub)`);
  }
  if (status.identity.state === "RESOLVED") {
    lines.push(`Account resolved: ${status.identity.resolvedLogin}`);
  }
  for (const r of status.resources) {
    if (r.progress === "INVITATION_PENDING")
      lines.push(`${r.displayName}: Organization invitation pending`);
    if (r.progress === "CONNECTED") lines.push(`${r.displayName}: GitHub access provisioned`);
    if (r.progress === "NEEDS_ATTENTION") lines.push(`${r.displayName}: Needs attention`);
  }
  return lines;
}

export function GitHubAccountForm({ workflowId }: { workflowId: string }) {
  const [adminToken, setAdminToken] = useState("");
  const [operatorId, setOperatorId] = useState("");
  const [login, setLogin] = useState("");
  const [status, setStatus] = useState<GitHubIdentityStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const url = `/api/admin/onboarding/${workflowId}/github-identity`;
  const auth = { authorization: `Bearer ${adminToken}` };

  async function request(init: RequestInit) {
    setMessage(null);
    try {
      const res = await fetch(url, init);
      const body = await res.json();
      if (!res.ok) {
        setMessage(body?.message ?? "Request failed");
        return;
      }
      setStatus(body);
      setLogin(body.identity.claimedLogin ?? "");
      if ("changed" in body) setMessage(body.changed ? "GitHub account saved" : "No change");
    } catch {
      setMessage("Could not reach the onboarding service.");
    }
  }

  const load = (e: FormEvent) => {
    e.preventDefault();
    void request({ headers: auth });
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void request({
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "x-operator-id": operatorId },
      body: JSON.stringify({ githubLogin: login.trim() }),
    });
  };

  return (
    <section>
      <form onSubmit={load}>
        <label htmlFor="admin-token">Operator token</label>{" "}
        <input
          id="admin-token"
          type="password"
          value={adminToken}
          onChange={(e) => setAdminToken(e.target.value)}
          autoComplete="off"
          required
        />{" "}
        <label htmlFor="operator-id">Your operator id</label>{" "}
        <input
          id="operator-id"
          value={operatorId}
          onChange={(e) => setOperatorId(e.target.value)}
          maxLength={64}
          required
        />{" "}
        <button type="submit">Load</button>
      </form>
      {status && (
        <>
          <p>
            Employee: {status.employee.firstName} {status.employee.lastName}
            <br />
            Work email: {status.employee.workEmail}
          </p>
          {status.identity.state !== "RESOLVED" ? (
            <form onSubmit={save}>
              <label htmlFor="github-login">GitHub username</label>{" "}
              <input
                id="github-login"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                maxLength={39}
                autoComplete="off"
                spellCheck={false}
                required
              />{" "}
              <button type="submit">Save GitHub Account</button>
            </form>
          ) : (
            <p>The GitHub account is linked. Changing it needs administrator remediation.</p>
          )}
          <h2>Status</h2>
          <ul>
            {statusLines(status).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
