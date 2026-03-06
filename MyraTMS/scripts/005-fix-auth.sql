-- Fix email domain from .io to .com
UPDATE users SET email = 'admin@myra.com' WHERE email = 'admin@myra.io';
UPDATE users SET email = 'ops@myra.com' WHERE email = 'ops@myra.io';
UPDATE users SET email = 'sales@myra.com' WHERE email = 'sales@myra.io';
