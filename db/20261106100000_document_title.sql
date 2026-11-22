-- Optional display title for a document (for example "Survey plan, 2019"). Kinds stay the coarse category; the title is what buyers read.
ALTER TABLE property_document ADD COLUMN IF NOT EXISTS title TEXT CHECK (title IS NULL OR char_length(title) <= 120);
