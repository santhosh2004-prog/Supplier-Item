sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "sap/f/LayoutType",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageToast",
  ],
  function (Controller, LayoutType, Filter, FilterOperator, MessageToast) {
    "use strict";

    return Controller.extend("supplieropenitems.controller.DetailDetail", {
      onInit: function () {
        var oRouter = this.getOwnerComponent().getRouter();
        oRouter
          .getRoute("detailDetail")
          .attachPatternMatched(this._onDetailDetailMatched, this);
      },

      // ═══════════════════════════════════════════════════════════════════
      //  ROUTE MATCHED
      // ═══════════════════════════════════════════════════════════════════

      _onDetailDetailMatched: function (oEvent) {
        var sIndex = oEvent.getParameter("arguments").index;
        var sVendorIndex = oEvent.getParameter("arguments").vendorIndex;
        var sVendorPath = "/items/" + sIndex + "/vendors/" + sVendorIndex;

        // Bind view to vendor context
        this.getView().bindElement({
          path: sVendorPath,
          model: "recon",
        });

        this._sVendorPath = sVendorPath;
        this._sReconIndex = sIndex;

        // ── Read stored filter values from recon model ──
        var oReconModel = this.getOwnerComponent().getModel("recon");
        var oFilters = oReconModel.getProperty("/selectedVendorFilters");

        console.log("📦 Filters received in DetailDetail:", oFilters);

        if (!oFilters) {
          console.warn("⚠️ No filter values found in model.");
          return;
        }

        // ── Fire OData call ──
        this._loadOpenItems(oFilters, sVendorPath);
      },

      // ═══════════════════════════════════════════════════════════════════
      //  LOAD OPEN ITEMS
      // ═══════════════════════════════════════════════════════════════════

      _loadOpenItems: function (oFilters, sVendorPath) {
        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this.getOwnerComponent().getModel("recon");

        oReconModel.setProperty(sVendorPath + "/itemsBusy", true);
        oReconModel.setProperty(sVendorPath + "/itemsLoaded", false);

        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, oFilters.Bukrs),
          new Filter("Budat", FilterOperator.EQ, new Date(oFilters.KeyDate)),
          new Filter("Akont", FilterOperator.EQ, oFilters.Akont),
          new Filter("Lifnr", FilterOperator.EQ, oFilters.Lifnr),
        ];

        console.log("🔍 Calling /OpenItemsSet with filters:", {
          Bukrs: oFilters.Bukrs,
          Budat: oFilters.KeyDate,
          Akont: oFilters.Akont,
          Lifnr: oFilters.Lifnr,
        });

        oModel.read("/OpenItemsSet", {
          filters: aFilters,
          success: function (oData) {
            console.log("✅ OpenItemsSet response:", oData.results);
            oReconModel.setProperty(
              sVendorPath + "/openItems",
              oData.results || [],
            );
            oReconModel.setProperty(sVendorPath + "/itemsBusy", false);
            oReconModel.setProperty(sVendorPath + "/itemsLoaded", true);
          },
          error: function (oError) {
            console.error("❌ OpenItemsSet read failed:", oError);
            oReconModel.setProperty(sVendorPath + "/itemsBusy", false);
            oReconModel.setProperty(sVendorPath + "/itemsLoaded", true);
            MessageToast.show("Error loading open items.");
          },
        });
      },

      // ═══════════════════════════════════════════════════════════════════
      //  FCL COLUMN ACTIONS
      // ═══════════════════════════════════════════════════════════════════

      handleFullScreen: function () {
        this.getOwnerComponent()
          .getModel("layout")
          .setProperty("/layout", LayoutType.EndColumnFullScreen);
      },

      handleExitFullScreen: function () {
        this.getOwnerComponent()
          .getModel("layout")
          .setProperty("/layout", LayoutType.ThreeColumnsMidExpanded);
      },

      handleClose: function () {
        this.getOwnerComponent()
          .getModel("layout")
          .setProperty("/layout", LayoutType.TwoColumnsMidExpanded);
        this.getOwnerComponent().getRouter().navTo("detail", {
          index: this._sReconIndex,
        });
      },
    });
  },
);
