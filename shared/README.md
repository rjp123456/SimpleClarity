# Clarity Lite Shared

Cross-project setup assets live here.

## Files

- `supabase_schema.sql`: SQL to create required Supabase tables (`face_references`, `geofence_config`, `reminders`, `events`), reminder medication columns, and enable realtime for `events`.

## Usage

1. Open Supabase SQL Editor.
2. Run `shared/supabase_schema.sql`.
3. Create storage buckets in Supabase Storage:
   - `face-references`
   - `medication-references`
