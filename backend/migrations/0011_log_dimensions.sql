-- Los cuatro desplegables del dashboard (/users, /categories, /devices, /sources)
-- resolvían un `SELECT DISTINCT` sobre `logs`: cuatro barridos completos de la tabla
-- por cada refresco, el 67% de las lecturas que reventaron la cuota diaria de D1.
-- Aquí viven los valores distintos; se alimenta al insertar un log y el cron diario
-- la reconstruye, para que un valor que ya no está en `logs` deje de aparecer.
CREATE TABLE IF NOT EXISTS log_dimensions (
  kind  TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (kind, value)
);

-- Relleno inicial. Cuatro barridos, UNA vez. Los cuatro excluyen USER_ACTION, igual
-- que `recordDimensions`: son logs de comportamiento de otro producto, se borran de
-- `logs` nada mas procesarlos y no deben salir en ningun desplegable.
INSERT OR IGNORE INTO log_dimensions (kind, value)
  SELECT DISTINCT 'user_id', user_id FROM logs
   WHERE user_id IS NOT NULL AND category != 'USER_ACTION';

INSERT OR IGNORE INTO log_dimensions (kind, value)
  SELECT DISTINCT 'device_id', device_id FROM logs
   WHERE device_id IS NOT NULL AND category != 'USER_ACTION';

INSERT OR IGNORE INTO log_dimensions (kind, value)
  SELECT DISTINCT 'source', source FROM logs
   WHERE source IS NOT NULL AND category != 'USER_ACTION';

INSERT OR IGNORE INTO log_dimensions (kind, value)
  SELECT DISTINCT 'category', category FROM logs
   WHERE category IS NOT NULL AND category != 'USER_ACTION'
     AND (endpoint IS NULL OR endpoint NOT LIKE '%/behaviour/%')
     AND NOT (level = 'debug' AND message LIKE '[HTTP]%');
