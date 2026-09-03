-- El GET /logs sin filtros ordena por created_at y no había índice en esa columna
-- SOLA (idx_logs_user_created solo sirve con user_id), así que cada página hacía un
-- barrido completo de la tabla. Con 359 MB eso consumió el límite diario de lecturas
-- del plan gratis de D1 (13.7M filas/día con 98 consultas) y el endpoint devolvía 500.
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC);

-- El cron de las 03:00 UTC busca los USER_ACTION rezagados por (category, created_at);
-- sin índice hacía otro barrido completo cada día.
CREATE INDEX IF NOT EXISTS idx_logs_category_created ON logs(category, created_at);
