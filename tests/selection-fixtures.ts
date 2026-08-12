import ExcelJS from "exceljs";

export const marketProductHeaders = [
  "Название товара", "Ссылка на товар", "Продавец", "Бренд", "Категория 1 уровня", "Категория 3 уровня",
  "Признак товара", "Заказано на сумму, ₽", "Динамика оборота, %", "Заказано, штуки", "Средняя цена, ₽",
  "Минимальная цена, ₽", "Доля выкупа, %", "Упущенные продажи", "Дней без остатка",
  "Среднесуточные продажи, ₽", "Среднесуточные продажи, штуки", "Остаток на конец периода, штуки",
  "Схема работы", "Объем товара, л", "Показы всего", "Просмотры в поиске и каталоге", "Просмотры карточки",
  "Конверсия из показа в заказ, %", "В корзину из поиска и каталога, %", "В корзину из карточки, %",
  "Скидка за счет акций", "Доля суммы заказов по акциям, %", "Дней в акциях", "Дней с продвижением",
  "Доля рекламных расходов, %", "Дата создания карточки товара",
];

/** Builds a minimal official Ozon all-metrics workbook for selection tests. */
export async function marketProductWorkbook(orderedAmount = 82_753_618, orderedUnits = 79_193): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  worksheet.addRow(["Дата формирования:", "08.11.26"]);
  worksheet.addRow(["Период отчета:", "28 дней"]);
  worksheet.addRow([]);
  worksheet.addRow(marketProductHeaders);
  worksheet.addRow(["Среднее значение по товарам"]);
  worksheet.addRow([
    "Святой Источник Hair Shampoo, 2000 ml", "https://www.ozon.ru/product/1710550744", "Beauty Seller", "VOIS",
    "Beauty & Hygiene", "洗发水", "Лидер по продажам", orderedAmount, -12, orderedUnits, 1045, 999,
    "Нет данных", 2500, "-", 2_357_414, 2269, 179_251, "FBO", 6.5, 4_820_000, 1_200_000,
    840_000, 4.2, 13.2, 16.8, 12, 64, "24 из 28", "27 из 28", 8.3, "2024-09-10",
  ]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
