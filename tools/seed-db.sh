#!/usr/bin/env bash
# Seeds a brand-new Mantice SQLite database with the smallest valid placeholder
# registry so the gateway can boot (it refuses empty routing tables). Then run
#   node tools/setup.mjs --config setup.json --replace
# to publish real class routes over the placeholder.
set -euo pipefail
db="${1:?usage: seed-db.sh /path/to/new.db}"
: > "$db"
sqlite3 "$db" <<'SQL'
PRAGMA journal_mode=WAL;
CREATE TABLE routing_provider_accounts(id TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE routing_deployments(id TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE routing_model_groups(name TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE routing_aliases(alias TEXT PRIMARY KEY,target TEXT NOT NULL);
CREATE TABLE routing_fallbacks(source TEXT NOT NULL,position INTEGER NOT NULL,target TEXT NOT NULL,PRIMARY KEY(source,position));
INSERT INTO routing_provider_accounts VALUES('placeholder','{"id":"placeholder","name":"Placeholder","kind":"openai","protocol":"openai","base_url":"https://example.invalid/v1","auth_kind":"none","credential":{},"adapters":{},"timeout_ms":1000,"enabled":true}');
INSERT INTO routing_deployments VALUES('placeholder-1','{"id":"placeholder-1","provider_id":"placeholder","model_group":"placeholder","upstream_model":"placeholder","priority":0,"weight":1,"enabled":true,"input_cost_per_token":0,"output_cost_per_token":0,"params":{}}');
INSERT INTO routing_model_groups VALUES('placeholder','{"name":"placeholder","mode":"chat","enabled":true,"public":true,"auto_optimize":false}');
SQL
echo "seeded placeholder registry at $db; boot the gateway, then run pi-mantice setup --replace"
