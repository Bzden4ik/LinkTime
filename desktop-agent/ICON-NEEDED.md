# ВАЖНО: Требуется иконка

Для полноценной работы Desktop Agent нужны файлы иконок:

## Необходимые файлы:

1. **icon.png** (512x512) - основная иконка
2. **icon.ico** (Windows)
3. **icon.icns** (macOS)

## Где взять иконки:

1. Создать в Figma/Photoshop
2. Использовать онлайн-генераторы:
   - https://www.icoconverter.com/
   - https://cloudconvert.com/
3. Или использовать временную иконку

## Временное решение:

Пока нет иконки, можно использовать любую PNG картинку 512x512:
```bash
# Скопировать любую иконку
cp /path/to/your/icon.png icon.png
```

## Для сборки:

- Windows (.ico): https://convertio.co/png-ico/
- macOS (.icns): https://cloudconvert.com/png-to-icns

Поместите готовые иконки в папку `desktop-agent/`
