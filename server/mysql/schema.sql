-- MySQL schema for the persistence layer (phase 5).
-- The server code talks to PersistenceStore (server/src/economy/store.ts);
-- a MySqlStore implementation maps 1:1 onto these tables. This environment
-- has no MySQL server, so the FileStore is the verified implementation and
-- this schema is the reviewed target for the real deployment.

CREATE TABLE IF NOT EXISTS accounts (
  username        VARCHAR(20)  NOT NULL,
  username_lower  VARCHAR(20)  NOT NULL,
  pass_hash       CHAR(64)     NOT NULL,          -- scrypt, hex
  salt            CHAR(32)     NOT NULL,
  created_at      DATETIME(3)  NOT NULL,
  equipped_cosmetic INT        NOT NULL DEFAULT 0,
  PRIMARY KEY (username_lower)
) ENGINE=InnoDB;

-- Append-only: no UPDATE or DELETE is ever issued against this table.
-- Balance = SUM(delta) per account_key. The unique ref is the idempotency
-- key: a retried write after a reconnect cannot double-apply.
CREATE TABLE IF NOT EXISTS transactions (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  ref          VARCHAR(64)  NOT NULL,
  account_key  VARCHAR(64)  NOT NULL,             -- 'acct:<username>' (guests are never persisted)
  delta        INT          NOT NULL,
  reason       VARCHAR(64)  NOT NULL,             -- 'kill:<victim>', 'buy:<item>', 'driving', ...
  at           DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ref (ref),
  KEY idx_account (account_key, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cosmetics_owned (
  username_lower VARCHAR(20) NOT NULL,
  cosmetic_id    INT         NOT NULL,
  acquired_at    DATETIME(3) NOT NULL,
  PRIMARY KEY (username_lower, cosmetic_id),
  CONSTRAINT fk_cosmetics_account FOREIGN KEY (username_lower)
    REFERENCES accounts (username_lower)
) ENGINE=InnoDB;
