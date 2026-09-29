# ServiceNow PDI setup: Autonomous Onboarding

This is a one-time manual setup of a ServiceNow Personal Developer Instance (PDI) for M4A: read-only connectivity. Nothing here can be automated from this repository, because creating the instance, the scoped application, the table, the role and the user all require an interactive ServiceNow login.

The table definition is taken from `src/table-spec.ts`. The live test and `pnpm servicenow:check --schema` compare the real table against it.

UI labels vary slightly between ServiceNow releases. Where they differ, follow the intent of each step.

## 1. Get a PDI

1. Sign in at <https://developer.servicenow.com> with a ServiceNow ID. Create one if needed.
2. Choose **Request Instance** and pick the latest release.
3. Record:
   - the instance URL, for example `https://dev123456.service-now.com`;
   - the `admin` password shown once, which you can reset from the developer portal later.
4. PDIs **hibernate** when idle and are **reclaimed** after a period without use. If requests start failing with `INSTANCE_UNAVAILABLE`, wake the instance from the developer portal.

## 2. Create the scoped application

1. Log in to the instance as `admin`.
2. Open **ServiceNow Studio** (older releases: **System Applications → Studio**) and create a new application. You can also use **App Engine Studio**.
   - **Name:** `Autonomous Onboarding`
   - **Scope:** accept the generated value. It looks like `x_<company code>_<short name>`, for example `x_1234567_autonomo`. Scope names are limited to 18 characters.
3. Note the scope. Every table and role name below starts with it.

## 3. Create the Onboarding Access Request table

In the application, create a new table:

| Setting                | Value                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| Label                  | `Onboarding Access Request`                                                                     |
| Name                   | `<scope>_onboarding_access_request`, for example `x_1234567_autonomo_onboarding_access_request` |
| Extends table          | **Task** (`task`)                                                                               |
| Auto-number            | on, prefix `OAR` (optional, recommended)                                                        |
| Create access controls | on (creates a `<scope>.<table>_user` role and ACLs)                                             |
| Create module          | optional                                                                                        |

Add these columns. In scoped applications, column names have **no `u_` prefix**.

| Column label          | Column name             | Type   | Max length | Mandatory | Notes                                         |
| --------------------- | ----------------------- | ------ | ---------- | --------- | --------------------------------------------- |
| Employee ID           | `employee_id`           | String | 100        | yes       | HRIS employee ID                              |
| Workflow ID           | `workflow_id`           | String | 40         | yes       | Our `onboarding_workflows.id` (UUID)          |
| Resource ID           | `resource_id`           | String | 255        | yes       | Catalog resource, e.g. `github:team:platform` |
| Requested Entitlement | `requested_entitlement` | String | 255        | yes       | e.g. `member`                                 |
| Agent Reason          | `agent_reason`          | String | 4000       | no        | Role Access Agent's rationale                 |
| Policy Decision       | `policy_decision`       | Choice | 40         | yes       | Choices below; default `pending`              |
| Correlation Key       | `correlation_key`       | String | 255        | yes       | **Unique** (see below)                        |

**Policy Decision choices.** The value must match exactly; the label is free:

| Value               | Label             |
| ------------------- | ----------------- |
| `pending`           | Pending           |
| `allow`             | Allow             |
| `deny`              | Deny              |
| `requires_approval` | Requires approval |

**Making `correlation_key` unique:**

1. Open the column's dictionary entry (**System Definition → Dictionary**, filter on table and column).
2. Switch to **Advanced view** and check **Unique**.

This creates a unique index, so ServiceNow itself rejects a second request with the same external correlation key. Our idempotency relies on this in M4B.

Task-inherited fields (`number`, `state`, `short_description`, `approval` and so on) come from the parent table. Don't recreate them.

## 4. Read-only role and ACL for the integration

1. Use the table's generated user role (`<scope>.<table>_user`) or create a dedicated one, for example `<scope>.integration_reader`.
2. Make sure a **read** ACL on the table (`<table>` and `<table>.*`) grants that role.
3. **Do not** grant create, write or delete to the integration role in M4A.

## 5. Create the integration user

**System Security → Users → New:**

- **User ID:** for example `aoo.integration`
- **Web service access only:** checked (no interactive UI login)
- **Active:** checked
- **Password:** set it with **Set Password**, and store it only in your local `.env` or a secret manager
- **Roles:** the read role from step 4 **only**. No `admin`, and no `itil` unless a later milestone needs it.

## 6. Configure the backend

Add the following to the git-ignored repo-root `.env`:

```sh
SERVICENOW_INSTANCE_URL=https://dev123456.service-now.com
SERVICENOW_USERNAME=aoo.integration
SERVICENOW_PASSWORD='<integration user password>'
SERVICENOW_ACCESS_REQUEST_TABLE=x_1234567_autonomo_onboarding_access_request
# Optional: admin credentials used ONLY by the live schema check (sys_db_object / sys_dictionary).
SERVICENOW_SCHEMA_USERNAME=admin
SERVICENOW_SCHEMA_PASSWORD='<schema verifier password>'
```

**Always single-quote passwords.** Generated ServiceNow passwords often contain `#`, `$` or `%`:

- in an unquoted `.env` value, `#` starts a comment, which silently truncates the password and causes a 401;
- Docker Compose expands `$`.

During M4A verification, a 100-character password was read as 62 characters until it was quoted.

The schema check can use a dedicated verifier account (for example `aoo.schema.verifier` with the `admin` role) instead of `admin`. On this PDI, `admin` itself was rejected for Basic-auth API calls.

## 7. Verify

```sh
pnpm servicenow:check            # auth + table query (integration user)
pnpm servicenow:check --schema   # + table definition check (needs dictionary read; see below)
pnpm test:servicenow:live        # explicit live test suite (GET requests only)
```

The schema check reads `sys_db_object` and `sys_dictionary`, which the least-privilege integration user normally can't read. The live test uses `SERVICENOW_SCHEMA_USERNAME`/`SERVICENOW_SCHEMA_PASSWORD` for that one check when they're set. `pnpm servicenow:check --schema` uses the main credentials.

To exercise the read-by-sys_id path against a real record, create one record by hand in the table's list view as `admin`. The backend itself never writes in M4A.

## 8. Preserve the application configuration (export)

Once the application is set up, export it into this directory and commit it:

1. In Studio, choose **Publish to Update Set** (older releases: **File → Publish to update set**). This creates a completed update set containing the application: the table, dictionary, choices, roles and ACLs.
2. Open **System Update Sets → Local Update Sets**, open that update set and choose **Export to XML**.
3. Save the file as `packages/servicenow/servicenow-app/update-sets/autonomous-onboarding-<version>.xml`.
4. Review the XML before committing.
   - It must not contain `sys_user` records or passwords. The integration user isn't part of the application, so it shouldn't.
   - To re-create the application on another instance, use **Retrieved Update Sets → Import Update Set from XML**, then preview and commit.

As an alternative, you can link the application to a Git repository with **Studio → Source Control**. The XML export is simpler for a PDI, which may be reclaimed.

## 9. M4B: create permission for the integration account

M4B creates Onboarding Access Request records. The integration account gets **create only**:

- no write or update;
- **no delete**;
- never the admin or schema-verifier account.

Set the application scope to **Autonomous Onboarding** first, so every change is captured in the application.

**1. Role.** Go to **System Security → Roles → New**:

- **Name:** `integration_writer`, saved as `x_2230066_autono_0.integration_writer`
- **Application:** Autonomous Onboarding

**2. Two create ACLs.** First elevate to `security_admin`, then go to **System Security → Access Control (ACL) → New**:

| Field         | ACL 1                                         | ACL 2                                |
| ------------- | --------------------------------------------- | ------------------------------------ |
| Type          | record                                        | record                               |
| Operation     | **create**                                    | **create**                           |
| Decision type | Allow If                                      | Allow If                             |
| Name          | Onboarding Access Request, field `-- None --` | Onboarding Access Request, field `*` |
| Requires role | `x_2230066_autono_0.integration_writer`       | same                                 |

Leave **Local or Existing** on **Local** and leave Security Attribute empty.

**Do not** create `write` or `delete` ACLs for this role. The adapter has no update or delete call.

**3. Assign the role.** Open user `aoo.integration` → **Roles** → **Edit…** and add `x_2230066_autono_0.integration_writer`. It should end up holding `integration_reader` and `integration_writer` only; ServiceNow may also auto-add `snc_required_script_writer_permission`.

**4. Verify.** `pnpm servicenow:check --schema` reports `access.problems: []`. It checks, through the schema-verification account:

- read and create are granted on the table and `table.*` via roles the integration user holds;
- the integration user is granted no delete or write;
- it holds no elevated role.

**5. Export** a new version. **Do not edit `autonomous-onboarding-1.0.0.xml`.** Publish the application as version `1.1.0` and export the update set to `update-sets/autonomous-onboarding-1.1.0.xml`, the same way as step 8. Review it for users or secrets before committing.

**6. Live write test.** Run `pnpm test:servicenow:live`, which runs the read-only suite and then the write suite. The write suite creates **synthetic** records only:

- correlation key prefix `aoo-test-oar-`;
- employee `TEST-EMP-M4B-LIVE`;
- short description `SYNTHETIC TEST RECORD – M4B …`.

It never deletes them, and each run adds 2 records.

## 10. M4C: approval state and the outbound approval callback

When a human approves or rejects an access request in ServiceNow, ServiceNow **notifies** the backend. The backend then **reads the ticket back** with the integration account and decides from that authoritative state. It never acts on the callback's own claims.

**1. Column.** Stay in the Autonomous Onboarding scope. Add a column to the Onboarding Access Request table:

| Label          | Name             | Type   | Max length | Mandatory | Default        | Choices (value: label)                                                                       |
| -------------- | ---------------- | ------ | ---------- | --------- | -------------- | -------------------------------------------------------------------------------------------- |
| Approval State | `approval_state` | Choice | 40         | yes       | `not_required` | `not_required`: Not required, `pending`: Pending, `approved`: Approved, `rejected`: Rejected |

Then add it to the form layout. It's separate from `policy_decision` and from Task's built-in `approval` field. The existing create and read ACLs (`table.*`) already cover the new column.

**2. Private GLOBAL properties.** These hold the callback secret. **They must be in the Global scope.** Application-scope properties are exported _with their values_ when the app is published, and the **Private** flag doesn't prevent that. This leaked the first secret in the first 1.2.0 export, and the secret was rotated.

Switch the application picker to **Global**, then create at `sys_properties_list.do` → **New**:

| Name                             | Type   | Value                                                                                    | Private |
| -------------------------------- | ------ | ---------------------------------------------------------------------------------------- | ------- |
| `aoo.approval_callback.url`      | string | `https://<your tunnel host>/webhooks/servicenow/approvals`                               | ✅      |
| `aoo.approval_callback.secret`   | string | a new random value of 32+ characters, the same as `SERVICENOW_CALLBACK_SECRET` in `.env` | ✅      |
| `aoo.approval_callback.instance` | string | `dev225201`                                                                              | ✅      |

- **Generate the secret** with `openssl rand -base64 36`. Don't reuse the HRIS secret or any password.
- **Scope:** switch back to **Autonomous Onboarding** afterwards.
- **No properties in the app:** there must be **no** `x_2230066_autono_0.aoo.approval_callback.*` properties. Delete any that exist.

**3. Business rule.** In the Autonomous Onboarding scope, go to **System Definition → Business Rules → New**. Configure it as the header of `servicenow-app/business-rules/aoo-approval-callback.js` describes:

- **Name:** AOO approval callback
- **Table:** Onboarding Access Request
- **Advanced:** ✅; **When:** async; **Update:** ✅
- **Filter:** Approval State **changes**, AND Approval State **is one of** approved, rejected
- **Script:** paste the file's script.

**4. Who approves.** In M4C the approver is a human (or `admin`) editing **Approval State** on the record's form. The integration account still has **no** write permission.

**5. Backend `.env`:**

```sh
SERVICENOW_CALLBACK_SECRET='<same value as aoo.approval_callback.secret>'
SERVICENOW_CALLBACK_INSTANCE=dev225201
SERVICENOW_CALLBACK_TABLE=x_2230066_autono_0_onboarding_access_request
```

**6. Tunnel.** ServiceNow must reach the backend over public HTTPS. For the live test, run a temporary tunnel to the test's local port (default 4810), for example `cloudflared tunnel --url http://localhost:4810`. Put its `https://…` host in `aoo.approval_callback.url`, then stop the tunnel after the test.

**7. Export** the application (M4C: version `1.2.2`) to `update-sets/autonomous-onboarding-1.2.2.xml`. **Before publishing**, run the read-only pre-export check: the app must have no property records (live or deleted) and no secrets or tunnel URLs in any update record. After exporting, inspect the file with flag-only output. Versions 1.2.0 and 1.2.1 were withdrawn because they contained secrets.

**8. Live test:** `pnpm test:servicenow:approval:live`. See CLAUDE.md for what it proves.

## 11. M7D: fulfillment records, the fulfiller role and the fulfillment callback

An authorized resource whose catalog provider is `SERVICENOW` (for example `aws-dev`, `aws-prod` or `slack-engineering`) gets its **own fulfillment record**, separate from any approval record. A human fulfiller performs the real external work (AWS access, Slack workspace…) outside AOO, then sets the record's **Fulfillment State**. AOO reads the record back and only the authoritative `fulfillment_state = fulfilled` makes the resource PROVISIONED. Creating the record is **not** provisioning.

Do everything in the **Autonomous Onboarding** scope unless a step says Global.

**1. Columns.** Add two columns to the Onboarding Access Request table, then add both to the form layout:

| Label             | Name                | Type   | Max length | Mandatory | Default    | Choices (value: label)                                                                   |
| ----------------- | ------------------- | ------ | ---------- | --------- | ---------- | ---------------------------------------------------------------------------------------- |
| Request Kind      | `request_kind`      | Choice | 40         | no        | `approval` | `approval`: Approval, `fulfillment`: Fulfillment                                         |
| Fulfillment State | `fulfillment_state` | Choice | 40         | no        | (none)     | `pending`: Pending, `in_progress`: In progress, `fulfilled`: Fulfilled, `failed`: Failed |

- Existing records keep an empty Request Kind: they are approval records. New approval records get the default `approval`; M7D fulfillment records are created with `request_kind = fulfillment`, `fulfillment_state = pending`, `approval_state = not_required`. Don't edit existing records.
- The integration account's existing **create** and **read** ACLs (`table` and `table.*`) already cover the new columns. **Don't** give the integration account write or delete.

**2. Fulfiller role.** **System Security → Roles → New**: name `fulfillment_agent` (the scoped name becomes `x_2230066_autono_0.fulfillment_agent`). No contained roles.

**3. Fulfiller ACLs** (**System Security → Access Control (ACL) → New**; elevate to `security_admin` first). Type **record** for all:

| Operation | Name                                              | Requires role       | Condition                                 |
| --------- | ------------------------------------------------- | ------------------- | ----------------------------------------- |
| read      | Onboarding Access Request → **None** (table)      | `fulfillment_agent` | Request Kind is Fulfillment               |
| read      | Onboarding Access Request → **\*** (all fields)   | `fulfillment_agent` | (none)                                    |
| write     | Onboarding Access Request → **None** (table)      | `fulfillment_agent` | Request Kind is Fulfillment               |
| write     | Onboarding Access Request → **Fulfillment State** | `fulfillment_agent` | Request Kind is Fulfillment               |
| write     | Onboarding Access Request → **\*** (all fields)   | **`admin`** only    | (none): keeps every other field read-only |

- The last row is the restrictive wildcard: without it, the table-level write would let the fulfiller change `correlation_key`, `approval_state`, `resource_id` and the identity fields. The specific **Fulfillment State** ACL overrides it for the fulfiller.
- **No** delete ACL for the fulfiller. **No** write on approval records (the condition).
- **Work notes are not supported in M7D.** A runtime check with the real fulfiller showed that a child-table `work_notes` write ACL is silently ignored (the inherited `task.work_notes` rules still apply). Don't add one, don't change `task.work_notes`, and don't grant `itil`, `task_editor` or `admin` to make it work. `pnpm servicenow:fulfillment:check` flags any fulfiller write grant other than `fulfillment_state`.

**4. Synthetic fulfiller account (PDI only, never exported).** **User Administration → Users → New**: user ID `aoo.fulfiller`, name "AOO Synthetic Fulfiller", a long random password, **Web service access only** if the field is on the form. Grant **only** `x_2230066_autono_0.fulfillment_agent` (plus whatever the platform requires for REST access). Not `admin`, not the integration roles. Users, passwords and role assignments are **not** part of the application and must never appear in an export.

**5. Global property** (switch the application picker to **Global**; `sys_properties_list.do` → New), then switch back:

| Name                           | Type   | Value                                                        | Private |
| ------------------------------ | ------ | ------------------------------------------------------------ | ------- |
| `aoo.fulfillment_callback.url` | string | `https://<your tunnel host>/webhooks/servicenow/fulfillment` | ✅      |

The rule reuses the existing global `aoo.approval_callback.secret` and `aoo.approval_callback.instance`. **Never** create application-scope properties (they export with their values).

**6. Business rule.** **System Definition → Business Rules → New**, configured as the header of `business-rules/aoo-fulfillment-callback.js` says:

- **Name:** AOO fulfillment callback; **Table:** Onboarding Access Request
- **Advanced:** ✅; **When:** async; **Update:** ✅
- **Filter:** Request Kind **is** Fulfillment, AND Fulfillment State **changes**
- **Script:** paste the file verbatim (it's tested byte-for-byte in `test/business-rule.test.ts`).

It's only a notification; the backend reads the record back. A lost callback is harmless: the worker's periodic reconciliation re-reads pending fulfillment records every `PROVISIONING_FULFILLMENT_RECONCILE_INTERVAL_MS`.

**7. Backend `.env`** (git-ignored; single-quote passwords):

```sh
SERVICENOW_FULFILLER_USERNAME='aoo.fulfiller'
SERVICENOW_FULFILLER_PASSWORD='<the fulfiller password>'
# Worker: create fulfillment records (off by default; Compose keeps it off unless set).
PROVISIONING_SERVICENOW_FULFILLMENT_ENABLED=true
```

**8. Verify (read-only):** `pnpm servicenow:fulfillment:check` must print `"ok": true` and `"writes": 0`. It checks the columns and choices, the integration account (create, no write/delete), the fulfiller role and ACLs, the business rule and the fulfiller account's roles, and prints no credentials.

**9. Export, gated.** Set the application version to **1.3.0**, then:

1. **Before publishing**, run `pnpm servicenow:export:check` (read-only). It scans every publish source of the app (update records, deleted-file records, scoped properties) for every configured secret value, tunnel URLs, Authorization headers, private keys, users, role assignments, properties and data rows, and prints **counts only**. It must print `"clean": true`. **If it doesn't, stop: don't publish.**
2. Publish to an update set and download it as `update-sets/autonomous-onboarding-1.3.0.xml`.
3. Run `pnpm servicenow:export:check --file packages/servicenow/servicenow-app/update-sets/autonomous-onboarding-1.3.0.xml`; it must also be clean before the file is committed. Earlier exports (1.0.0, 1.1.0, 1.2.2) stay unchanged.

**10. Live test:** `pnpm test:servicenow:fulfillment:live` (creates one synthetic fulfillment record; the synthetic fulfiller marks it fulfilled).
