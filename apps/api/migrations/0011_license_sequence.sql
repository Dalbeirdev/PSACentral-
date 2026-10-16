-- Module 14 — License identifiers (LIC-xxxxx) draw from the per-organization sequence like clients and deployments.
ALTER TABLE organization_sequences DROP CONSTRAINT IF EXISTS organization_sequences_name_check;
ALTER TABLE organization_sequences ADD CONSTRAINT organization_sequences_name_check CHECK (name IN ('client', 'psa_instance', 'deployment', 'license'));
