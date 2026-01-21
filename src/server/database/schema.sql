-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id VARCHAR(255) NOT NULL,
  symbol VARCHAR(50) NOT NULL,
  security_type VARCHAR(50) NOT NULL,

  -- Option-specific fields
  option_symbol VARCHAR(100),
  option_type VARCHAR(10),
  strike_price DECIMAL(10, 2),
  expiration_date TIMESTAMP WITH TIME ZONE,

  -- Order details
  action VARCHAR(20) NOT NULL,
  order_type VARCHAR(50) NOT NULL,
  quantity INTEGER NOT NULL,
  limit_price DECIMAL(10, 2),
  stop_price DECIMAL(10, 2),

  -- Duration and scheduling
  preferred_duration VARCHAR(50) NOT NULL,
  actual_duration VARCHAR(50) NOT NULL,
  requires_daily BOOLEAN NOT NULL DEFAULT false,
  session_time VARCHAR(20) NOT NULL,

  -- Scheduling
  scheduled_for TIMESTAMP WITH TIME ZONE,
  schedule_enabled BOOLEAN NOT NULL DEFAULT false,

  -- Status tracking
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  etrade_order_id VARCHAR(100),
  submitted_at TIMESTAMP WITH TIME ZONE,
  filled_at TIMESTAMP WITH TIME ZONE,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,

  -- Error tracking
  last_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,

  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  notes TEXT
);

-- Scheduled orders tracking (for distributed locking)
CREATE TABLE IF NOT EXISTS scheduled_order_locks (
  order_id UUID PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  scheduled_time TIMESTAMP WITH TIME ZONE NOT NULL,
  session_time VARCHAR(20) NOT NULL,
  locked BOOLEAN NOT NULL DEFAULT false,
  locked_by VARCHAR(100),
  locked_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Order execution history
CREATE TABLE IF NOT EXISTS order_executions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  execution_time TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  etrade_order_id VARCHAR(100),
  status VARCHAR(50) NOT NULL,
  filled_quantity INTEGER,
  average_price DECIMAL(10, 4),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_scheduled_for ON orders(scheduled_for) WHERE schedule_enabled = true;
CREATE INDEX IF NOT EXISTS idx_orders_account_id ON orders(account_id);
CREATE INDEX IF NOT EXISTS idx_orders_symbol ON orders(symbol);
CREATE INDEX IF NOT EXISTS idx_orders_expires_at ON orders(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scheduled_locks_time ON scheduled_order_locks(scheduled_time, locked);
CREATE INDEX IF NOT EXISTS idx_order_executions_order_id ON order_executions(order_id);
CREATE INDEX IF NOT EXISTS idx_order_executions_time ON order_executions(execution_time);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to automatically update updated_at
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to clean up expired locks
CREATE OR REPLACE FUNCTION cleanup_expired_locks()
RETURNS void AS $$
BEGIN
  UPDATE scheduled_order_locks
  SET locked = false, locked_by = NULL, locked_at = NULL
  WHERE locked = true AND locked_at < NOW() - INTERVAL '5 minutes';
END;
$$ language 'plpgsql';
