-- Media labels are English, like the rest of the app; the chronicler reads them in its prompt as [photo], [voice] and so on.
UPDATE messages SET media_type = labels.english
FROM (VALUES ('фото', 'photo'), ('видео', 'video'), ('кружок', 'video note'), ('голосовое', 'voice'), ('аудио', 'audio'),
             ('файл', 'file'), ('стикер', 'sticker'), ('гифка', 'GIF'), ('опрос', 'poll')) AS labels (russian, english)
WHERE messages.media_type = labels.russian;
