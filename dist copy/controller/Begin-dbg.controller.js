sap.ui.define(["sap/ui/core/mvc/Controller"], function (Controller) {
  "use strict";

  // Category keyword → icon + Avatar backgroundColor (built-in enum, no CSS needed)
  // Valid sap.m.Avatar backgroundColor values: Accent1..Accent10, etc.
  var CATEGORY_STYLE_MAP = [
    { keyword: "raw material", icon: "sap-icon://product", color: "Accent6" },
    {
      keyword: "packing",
      icon: "sap-icon://sales-order-item",
      color: "Accent5",
    },
    { keyword: "import", icon: "sap-icon://world", color: "Accent8" },
    { keyword: "services", icon: "sap-icon://factory", color: "Accent3" },
    { keyword: "manufacturing", icon: "sap-icon://factory", color: "Accent3" },
    {
      keyword: "selling",
      icon: "sap-icon://shipping-status",
      color: "Accent2",
    },
    {
      keyword: "distribution",
      icon: "sap-icon://shipping-status",
      color: "Accent2",
    },
    { keyword: "others", icon: "sap-icon://discussion-2", color: "Accent7" },
    { keyword: "property", icon: "sap-icon://home", color: "Accent9" },
    { keyword: "sto", icon: "sap-icon://synchronize", color: "Accent10" },
    { keyword: "loans", icon: "sap-icon://money-bills", color: "Accent4" },
  ];
  var DEFAULT_STYLE = { icon: "sap-icon://folder", color: "Accent1" };

  function resolveCategoryStyle(sTxt) {
    if (!sTxt) return DEFAULT_STYLE;
    var sLower = sTxt.toLowerCase();
    for (var i = 0; i < CATEGORY_STYLE_MAP.length; i++) {
      if (sLower.indexOf(CATEGORY_STYLE_MAP[i].keyword) > -1) {
        return CATEGORY_STYLE_MAP[i];
      }
    }
    return DEFAULT_STYLE;
  }

  return Controller.extend("supplieropenitems.controller.Begin", {
    onInit: function () {
      // "recon" model is set at Component level by Main — available automatically
    },

    // ═══════════════════════════════════════════════════════════════════
    //  FORMATTERS
    // ═══════════════════════════════════════════════════════════════════

    formatAmount: function (val) {
      if (val === null || val === undefined || val === "") return "";
      return parseFloat(val).toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    },

    formatNetAmount: function (fInv, fAdv) {
      var fNet = (parseFloat(fInv) || 0) + (parseFloat(fAdv) || 0);
      return this.formatAmount(fNet);
    },

    formatCategory: function (sTxt) {
      if (!sTxt) return "";
      var i = sTxt.indexOf("-");
      return i > -1 ? sTxt.substring(i + 1).trim() : sTxt;
    },

    formatCategoryIcon: function (sTxt) {
      var sClean = this.formatCategory(sTxt);
      return resolveCategoryStyle(sClean).icon;
    },

    formatCategoryColor: function (sTxt) {
      var sClean = this.formatCategory(sTxt);
      return resolveCategoryStyle(sClean).color;
    },

    // ═══════════════════════════════════════════════════════════════════
    //  CARD PRESS → navigate to Mid column (vendor detail)
    // ═══════════════════════════════════════════════════════════════════

    onReconPress: function (oEvent) {
      var oItem = oEvent.getSource();
      var oCtx = oItem.getBindingContext("recon");
      var oRecon = oCtx.getObject();
      var iIndex = oCtx.getPath().split("/").pop();

      console.log("➡️ Category selected:", {
        index: iIndex,
        Akont: oRecon.Akont,
        Txt50: oRecon.Txt50,
      });

      // Navigate to detail route — opens the mid column
      this.getOwnerComponent().getRouter().navTo("detail", {
        index: iIndex,
      });
    },
  });
});
