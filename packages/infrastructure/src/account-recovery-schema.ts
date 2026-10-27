import { sql } from 'drizzle-orm';
import { check,foreignKey,index,integer,pgTable,primaryKey,text,timestamp,unique,uniqueIndex,uuid } from 'drizzle-orm/pg-core';
import { users } from './schema.ts';

/** SQL triggers in 0027 additionally enforce immutable identities and terminal states. */
export const accountRecoveryTokens=pgTable('account_recovery_tokens',{
  id:uuid('id').primaryKey(),userId:uuid('user_id').notNull().references(()=>users.id),
  purpose:text('purpose').$type<'verify_recovery_email'|'reset_password'>().notNull(),tokenHash:text('token_hash').notNull().unique(),candidateEmail:text('candidate_email'),
  credentialVersion:integer('credential_version').notNull(),recoveryEmailVersion:integer('recovery_email_version').notNull(),
  status:text('status').$type<'active'|'consumed'|'revoked'|'expired'>().notNull().default('active'),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().default(sql`clock_timestamp()`),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),consumedAt:timestamp('consumed_at',{withTimezone:true}),
},t=>[
  unique('account_recovery_tokens_id_purpose_key').on(t.id,t.purpose),
  uniqueIndex('account_recovery_tokens_active_unique').on(t.userId,t.purpose).where(sql`${t.status}='active'`),index('account_recovery_tokens_user_idx').on(t.userId),
  check('account_recovery_tokens_purpose_check',sql`${t.purpose} IN ('verify_recovery_email','reset_password')`),check('account_recovery_tokens_token_hash_check',sql`${t.tokenHash} ~ '^[a-f0-9]{64}$'`),
  check('account_recovery_tokens_credential_version_check',sql`${t.credentialVersion}>0`),check('account_recovery_tokens_recovery_email_version_check',sql`${t.recoveryEmailVersion}>0`),
  check('account_recovery_tokens_status_check',sql`${t.status} IN ('active','consumed','revoked','expired')`),check('account_recovery_tokens_expiry_check',sql`${t.expiresAt}>${t.createdAt}`),
  check('account_recovery_tokens_consumed_check',sql`(${t.status}='consumed')=(${t.consumedAt} IS NOT NULL)`),
  check('account_recovery_tokens_candidate_check',sql`(${t.purpose}='verify_recovery_email' AND ${t.candidateEmail} IS NOT NULL AND ${t.candidateEmail}=lower(btrim(${t.candidateEmail})) AND length(${t.candidateEmail}) BETWEEN 3 AND 254) OR (${t.purpose}='reset_password' AND ${t.candidateEmail} IS NULL)`),
]);
export const accountRecoveryMailQueue=pgTable('account_recovery_mail_queue',{
  id:uuid('id').primaryKey(),tokenId:uuid('token_id').notNull().unique().references(()=>accountRecoveryTokens.id),purpose:text('purpose').$type<'verify_recovery_email'|'reset_password'>().notNull(),
  status:text('status').$type<'queued'|'sending'|'smtp_accepted'|'failed'|'unknown'|'cancelled'>().notNull().default('queued'),tokenCiphertext:text('token_ciphertext'),leaseId:uuid('lease_id'),leaseExpiresAt:timestamp('lease_expires_at',{withTimezone:true}),failureCode:text('failure_code'),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().default(sql`clock_timestamp()`),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().default(sql`clock_timestamp()`),
},t=>[
  foreignKey({columns:[t.tokenId,t.purpose],foreignColumns:[accountRecoveryTokens.id,accountRecoveryTokens.purpose]}),
  index('account_recovery_mail_queued_idx').on(t.createdAt,t.id).where(sql`${t.status}='queued'`),
  check('account_recovery_mail_queue_purpose_check',sql`${t.purpose} IN ('verify_recovery_email','reset_password')`),check('account_recovery_mail_queue_status_check',sql`${t.status} IN ('queued','sending','smtp_accepted','failed','unknown','cancelled')`),
  check('account_recovery_mail_queue_failure_code_check',sql`${t.failureCode} IN ('smtp_rejected','smtp_configuration','smtp_unavailable','send_outcome_unknown','send_lease_expired','token_unavailable')`),
  check('account_recovery_mail_queue_ciphertext_check',sql`(${t.status}='queued')=(${t.tokenCiphertext} IS NOT NULL)`),check('account_recovery_mail_queue_lease_check',sql`(${t.status}='sending')=(${t.leaseId} IS NOT NULL)`),check('account_recovery_mail_queue_lease_expiry_check',sql`(${t.status}='sending')=(${t.leaseExpiresAt} IS NOT NULL)`),
  check('account_recovery_mail_queue_failure_check',sql`(${t.status} IN ('failed','unknown'))=(${t.failureCode} IS NOT NULL)`),
]);
export const accountRecoveryRequests=pgTable('account_recovery_requests',{
  requestId:uuid('request_id').primaryKey(),addressKey:text('address_key'),tokenId:uuid('token_id').references(()=>accountRecoveryTokens.id),status:text('status').$type<'accepted'|'cancelled'>().notNull(),occurredAt:timestamp('occurred_at',{withTimezone:true}).notNull().default(sql`clock_timestamp()`),
},t=>[
  check('account_recovery_requests_address_key_check',sql`${t.addressKey} ~ '^[a-f0-9]{64}$'`),check('account_recovery_requests_status_check',sql`${t.status} IN ('accepted','cancelled')`),
  check('account_recovery_requests_fence_check',sql`(${t.status}='accepted' AND ${t.addressKey} IS NOT NULL) OR (${t.status}='cancelled' AND ${t.addressKey} IS NULL AND ${t.tokenId} IS NULL)`),
]);
export const accountPasswordResetActions=pgTable('account_password_reset_actions',{
  tokenId:uuid('token_id').notNull().references(()=>accountRecoveryTokens.id),actionId:uuid('action_id').notNull().unique(),status:text('status').$type<'committed'|'rejected'|'cancelled'>().notNull(),credentialVersionAfter:integer('credential_version_after'),revokedCount:integer('revoked_count').notNull().default(0),errorCode:text('error_code'),httpStatus:integer('http_status').notNull(),occurredAt:timestamp('occurred_at',{withTimezone:true}).notNull().default(sql`clock_timestamp()`),
},t=>[
  primaryKey({columns:[t.tokenId,t.actionId]}),check('account_password_reset_actions_status_check',sql`${t.status} IN ('committed','rejected','cancelled')`),check('account_password_reset_actions_credential_version_after_check',sql`${t.credentialVersionAfter}>0`),check('account_password_reset_actions_revoked_count_check',sql`${t.revokedCount}>=0`),
  check('account_password_reset_actions_error_code_check',sql`${t.errorCode} IN ('recovery_link_unavailable','password_unchanged')`),check('account_password_reset_actions_http_status_check',sql`${t.httpStatus} IN (200,400,409)`),
  check('account_password_reset_actions_outcome_check',sql`(${t.status}='rejected' AND ${t.errorCode} IS NOT NULL AND ${t.httpStatus}<>200 AND ${t.credentialVersionAfter} IS NULL) OR (${t.status}='committed' AND ${t.errorCode} IS NULL AND ${t.httpStatus}=200 AND ${t.credentialVersionAfter} IS NOT NULL) OR (${t.status}='cancelled' AND ${t.errorCode} IS NULL AND ${t.httpStatus}=200 AND ${t.credentialVersionAfter} IS NULL)`),
]);
