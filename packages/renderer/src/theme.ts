/**
 * Visual design.
 *
 * Stage 1 is deliberately conservative: a user should recognise a table
 * instantly. Colours are linear RGBA in `[0, 1]` so they can go straight into
 * GPU buffers without a per-frame conversion.
 */

export type Rgba = readonly [number, number, number, number];

export interface TableTheme {
  readonly background: Rgba;
  readonly headerBackground: Rgba;
  readonly titleBackground: Rgba;
  readonly gutterBackground: Rgba;
  readonly rowBackground: Rgba;
  readonly rowAlternateBackground: Rgba;
  readonly rowHoverBackground: Rgba;
  readonly placeholderFill: Rgba;
  readonly gridLine: Rgba;
  readonly border: Rgba;
  readonly selectedBorder: Rgba;
  readonly titleText: Rgba;
  readonly headerText: Rgba;
  readonly typeText: Rgba;
  readonly cellText: Rgba;
  readonly gutterText: Rgba;
  readonly nullText: Rgba;
  readonly scrollbar: Rgba;
  readonly scrollbarTrack: Rgba;
  readonly resizeHandle: Rgba;
  readonly canvasBackground: Rgba;
  readonly haloBackground: Rgba;
  readonly haloHoverBackground: Rgba;
  readonly haloPressedBackground: Rgba;
  readonly haloBorder: Rgba;
  readonly haloIcon: Rgba;
  readonly haloHoverIcon: Rgba;
  readonly connectorLine: Rgba;
  readonly connectorHighlight: Rgba;
  readonly connectorLabelText: Rgba;
  readonly connectorLabelBackground: Rgba;
  readonly connectorMarkerBackground: Rgba;
  readonly connectorMarkerHoverBackground: Rgba;
  readonly connectorMarkerBorder: Rgba;
  readonly connectorMarkerIcon: Rgba;
  readonly connectorMarkerHoverIcon: Rgba;
  /** Cells that can be followed to the rows their foreign key points at. */
  readonly linkText: Rgba;

  readonly titleHeight: number;
  readonly typeRowHeight: number;
  readonly cellPaddingX: number;
  readonly gridLineWidth: number;
  readonly borderWidth: number;
  readonly scrollbarWidth: number;
  readonly scrollbarMinLength: number;
  readonly resizeMargin: number;
  /** Diameter of a halo button, in screen pixels. */
  readonly haloButtonSize: number;
  readonly haloGap: number;
  /** Distance from the table's top edge to the halo, in screen pixels. */
  readonly haloOffset: number;
  readonly haloIconFontSize: number;
  /** Connector metrics, in screen pixels. */
  readonly connectorWidth: number;
  readonly connectorGap: number;
  readonly connectorArrowLength: number;
  readonly connectorArrowWidth: number;
  readonly connectorLabelFontSize: number;
  readonly connectorLabelPaddingX: number;
  /** Side of the square marker sitting on a connector, in screen pixels. */
  readonly connectorMarkerSize: number;
  readonly connectorMarkerIconSize: number;
  readonly fontSize: number;
  readonly headerFontSize: number;
  readonly typeFontSize: number;
  readonly titleFontSize: number;
}

const rgb = (hex: number, alpha = 1): Rgba => [
  ((hex >> 16) & 0xff) / 255,
  ((hex >> 8) & 0xff) / 255,
  (hex & 0xff) / 255,
  alpha,
];

export const DEFAULT_TABLE_THEME: TableTheme = Object.freeze({
  background: rgb(0xff_ff_ff),
  headerBackground: rgb(0xf4_f5_f7),
  titleBackground: rgb(0xe9_ec_ef),
  gutterBackground: rgb(0xf8_f9_fa),
  rowBackground: rgb(0xff_ff_ff),
  rowAlternateBackground: rgb(0xfa_fb_fc),
  rowHoverBackground: rgb(0xe8_f1_fb),
  placeholderFill: rgb(0xdf_e3_e8, 0.75),
  gridLine: rgb(0xe3_e6_ea),
  border: rgb(0xb9_c0_c8),
  selectedBorder: rgb(0x2f_6f_ed),
  titleText: rgb(0x1c_21_27),
  headerText: rgb(0x2b_31_38),
  typeText: rgb(0x76_7f_89),
  cellText: rgb(0x21_26_2c),
  gutterText: rgb(0x8b_94_9e),
  nullText: rgb(0xa9_b1_ba),
  scrollbar: rgb(0x9a_a3_ad, 0.75),
  scrollbarTrack: rgb(0x00_00_00, 0.05),
  resizeHandle: rgb(0x2f_6f_ed, 0.85),
  canvasBackground: rgb(0xf1_f3_f5),
  haloBackground: rgb(0xff_ff_ff, 0.96),
  haloHoverBackground: rgb(0xd6_3b_2f),
  haloPressedBackground: rgb(0xa8_2c_22),
  haloBorder: rgb(0xb9_c0_c8),
  haloIcon: rgb(0x3c_44_4d),
  haloHoverIcon: rgb(0xff_ff_ff),
  connectorLine: rgb(0x6b_7a_8f),
  connectorHighlight: rgb(0x2f_6f_ed),
  connectorLabelText: rgb(0x3c_44_4d),
  connectorLabelBackground: rgb(0xff_ff_ff, 0.97),
  connectorMarkerBackground: rgb(0xff_ff_ff, 0.97),
  connectorMarkerHoverBackground: rgb(0x2f_6f_ed),
  connectorMarkerBorder: rgb(0x9a_a3_ad),
  connectorMarkerIcon: rgb(0x5c_66_71),
  connectorMarkerHoverIcon: rgb(0xff_ff_ff),
  linkText: rgb(0x1c_5b_c4),

  titleHeight: 26,
  typeRowHeight: 22,
  cellPaddingX: 8,
  gridLineWidth: 1,
  borderWidth: 1,
  scrollbarWidth: 8,
  scrollbarMinLength: 24,
  resizeMargin: 6,
  haloButtonSize: 22,
  haloGap: 6,
  haloOffset: 8,
  haloIconFontSize: 15,
  connectorWidth: 1.75,
  connectorGap: 4,
  connectorArrowLength: 11,
  connectorArrowWidth: 9,
  connectorLabelFontSize: 10,
  connectorLabelPaddingX: 6,
  connectorMarkerSize: 22,
  connectorMarkerIconSize: 15,
  fontSize: 12,
  headerFontSize: 12,
  typeFontSize: 10,
  titleFontSize: 13,
});
