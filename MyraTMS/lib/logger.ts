type LogData = Record<string, unknown>;

function normalize(data: unknown): LogData | undefined {
  if (data == null) return undefined;
  if (typeof data === 'object' && !(data instanceof Error)) return data as LogData;
  if (data instanceof Error) return { error: data.message, stack: data.stack };
  return { value: String(data) };
}

function emit(level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: unknown): void {
  const line = JSON.stringify({ level, message, ...normalize(data), ts: new Date().toISOString() });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return `***${digits.slice(-4)}`;
}

function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const [user, domain] = email.split('@');
  if (!domain) return '****';
  const head = user.slice(0, 1);
  return `${head}***@${domain}`;
}

export const logger = {
  info:  (msg: string, data?: unknown) => emit('info', msg, data),
  warn:  (msg: string, data?: unknown) => emit('warn', msg, data),
  error: (msg: string, data?: unknown) => emit('error', msg, data),
  debug: (msg: string, data?: unknown) => emit('debug', msg, data),
  maskPhone,
  maskEmail,
};
