export function now() {
  return new Date().toISOString();
}

export function ensure(obj: any, field: string, def = '') {
  return obj?.[field] ? obj[field] : def;
}
